import * as Mp4Muxer from 'mp4-muxer';
import * as WebmMuxer from 'webm-muxer';
import { normalizeHtmlDocument } from './htmlNormalizer';

export type VideoFormat = 'mp4' | 'webm';

export interface ExportOptions {
  html: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  format: VideoFormat;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}

export interface ExportProgress {
  phase: 'preparing' | 'rendering' | 'finalizing';
  frame: number;
  totalFrames: number;
  percent: number;
}

export interface ExportResult {
  blob: Blob;
  url: string;
  mimeType: string;
  extension: 'mp4' | 'webm';
  sizeBytes: number;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  renderTimeMs: number;
  encoderUsed: string;
}

interface FrameClockWindow extends Window {
  __FRAMEHTML_CLOCK__?: {
    advanceTo: (ms: number) => void;
  };
}

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const IGNORED_KEYFRAME_PROPS = new Set(['offset', 'computedOffset', 'easing', 'composite']);

function makeEven(n: number): number {
  const rounded = Math.round(n);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function toKebabCase(prop: string): string {
  if (prop.startsWith('--')) return prop;
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function resolveOpaqueBackground(doc: Document): string {
  const win = doc.defaultView;
  if (!win) return '#ffffff';

  const isTransparent = (color: string) =>
    !color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)';

  const bodyBg = doc.body ? win.getComputedStyle(doc.body).backgroundColor : '';
  if (!isTransparent(bodyBg)) return bodyBg;

  const htmlBg = doc.documentElement ? win.getComputedStyle(doc.documentElement).backgroundColor : '';
  if (!isTransparent(htmlBg)) return htmlBg;

  return '#ffffff';
}

function findSingleFullCanvas(doc: Document, width: number, height: number): HTMLCanvasElement | null {
  const body = doc.body;
  if (!body) return null;

  const canvases = body.querySelectorAll('canvas');
  if (canvases.length !== 1) return null;

  const canvas = canvases[0];
  const rect = canvas.getBoundingClientRect();
  if (rect.width < width - 2 || rect.height < height - 2) return null;

  const meaningfulChildren = Array.from(body.children).filter((el) => {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') return false;
    if (el === canvas) return true;
    const style = doc.defaultView?.getComputedStyle(el);
    return style?.display !== 'none' && style?.visibility !== 'hidden' && style?.opacity !== '0';
  });

  return meaningfulChildren.length === 1 && meaningfulChildren[0] === canvas ? canvas : null;
}

async function waitForIframeReady(iframe: HTMLIFrameElement): Promise<Document> {
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => resolve(), 2500);
    iframe.onload = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    iframe.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Failed to load HTML preview for capture.'));
    };
  });

  const doc = iframe.contentDocument;
  if (!doc) {
    throw new Error('Could not access iframe document.');
  }

  try {
    if (doc.fonts?.ready) {
      await Promise.race([doc.fonts.ready, new Promise((r) => setTimeout(r, 1000))]);
    }
  } catch {
    // Ignore font readiness errors from cross-origin stylesheets
  }

  const images = Array.from(doc.images || []);
  if (images.length > 0) {
    await Promise.race([
      Promise.all(
        images.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise<void>((res) => {
                img.onload = () => res();
                img.onerror = () => res();
              })
        )
      ),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  }

  return doc;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Read failed'));
    reader.onerror = () => reject(new Error('Read failed'));
    reader.readAsDataURL(blob);
  });
}

async function inlineFontUrlsInCss(cssText: string, baseUrl: string): Promise<string> {
  const urlMatches = Array.from(cssText.matchAll(/url\((['"]?)(https?:\/\/[^'")]+)\1\)/g));
  if (urlMatches.length === 0) return cssText;

  const uniqueUrls = Array.from(new Set(urlMatches.map((m) => m[2]))).slice(0, 16);
  const replacements = new Map<string, string>();

  await Promise.all(
    uniqueUrls.map(async (rawUrl) => {
      try {
        const resolved = new URL(rawUrl, baseUrl).href;
        const res = await fetch(resolved);
        if (!res.ok) return;
        const blob = await res.blob();
        const dataUrl = await blobToDataUrl(blob);
        replacements.set(rawUrl, dataUrl);
      } catch {
        // Ignore CORS-blocked font/asset URLs
      }
    })
  );

  if (replacements.size === 0) return cssText;
  return cssText.replace(/url\((['"]?)(https?:\/\/[^'")]+)\1\)/g, (full, q, url) => {
    const dataUrl = replacements.get(url);
    return dataUrl ? `url(${q}${dataUrl}${q})` : full;
  });
}

async function inlineExternalResourcesOnce(doc: Document): Promise<void> {
  const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | void> =>
    Promise.race([promise, new Promise<void>((r) => setTimeout(r, ms))]);

  const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]')) as HTMLLinkElement[];
  if (links.length > 0) {
    await withTimeout(
      Promise.all(
        links.map(async (link) => {
          const href = link.href;
          if (!href) return;
          try {
            const res = await fetch(href);
            if (!res.ok) return;
            const rawCss = await res.text();
            const inlinedCss = await inlineFontUrlsInCss(rawCss, href);
            const style = doc.createElement('style');
            style.textContent = inlinedCss;
            link.replaceWith(style);
          } catch {
            // Keep link if blocked by CORS
          }
        })
      ),
      1500
    );
  }

  const styles = Array.from(doc.querySelectorAll('style'));
  if (styles.length > 0) {
    await withTimeout(
      Promise.all(
        styles.map(async (style) => {
          if (!style.textContent || !style.textContent.includes('http')) return;
          style.textContent = await inlineFontUrlsInCss(style.textContent, doc.baseURI);
        })
      ),
      1000
    );
  }

  try {
    const dynamicRules: string[] = [];
    for (let i = 0; i < doc.styleSheets.length; i++) {
      const sheet = doc.styleSheets[i];
      const owner = sheet.ownerNode as Element | null;
      if (owner && owner.tagName === 'STYLE' && !owner.textContent?.trim()) {
        try {
          for (let r = 0; r < sheet.cssRules.length; r++) {
            dynamicRules.push(sheet.cssRules[r].cssText);
          }
        } catch {
          // Cross-origin stylesheet
        }
      }
    }
    if (dynamicRules.length > 0) {
      const dynamicStyle = doc.createElement('style');
      dynamicStyle.textContent = dynamicRules.join('\n');
      doc.head?.appendChild(dynamicStyle);
    }
  } catch {
    // Ignore CSSOM inspection errors
  }

  const imgs = Array.from(doc.images || []).filter((img) => {
    const src = img.getAttribute('src') || '';
    return Boolean(src && !src.startsWith('data:') && !src.startsWith('blob:'));
  });
  if (imgs.length > 0) {
    await withTimeout(
      Promise.all(
        imgs.map(async (img) => {
          try {
            const res = await fetch(img.src);
            if (!res.ok) return;
            const blob = await res.blob();
            img.src = await blobToDataUrl(blob);
          } catch {
            // Keep original src if CORS blocks fetch
          }
        })
      ),
      1500
    );
  }
}

interface SnapshotBuilder {
  buildFrameSvgBlobUrl: () => string;
}

function createFastDomSnapshotBuilder(doc: Document, width: number, height: number): SnapshotBuilder {
  const win = doc.defaultView!;
  const serializer = new XMLSerializer();
  const animPropsCache = new WeakMap<Animation, string[]>();

  const buildStaticHeadXml = (): string => {
    const clonedHead = doc.head ? (doc.head.cloneNode(true) as HTMLElement) : doc.createElementNS(XHTML_NS, 'head');
    const headScripts = clonedHead.querySelectorAll('script, noscript');
    for (let i = 0; i < headScripts.length; i++) headScripts[i].remove();
    clonedHead.setAttribute('xmlns', XHTML_NS);
    return serializer.serializeToString(clonedHead);
  };

  let cachedHeadCount = doc.head ? doc.head.children.length : 0;
  let staticHeadXml = buildStaticHeadXml();
  const hasSmilElements = doc.querySelector('svg animate, svg animateTransform, svg animateMotion') !== null;
  const hasCanvases = doc.querySelector('canvas') !== null;
  const hasBodyScripts = doc.body ? doc.body.querySelector('script, noscript') !== null : false;

  const htmlOpenTag = (() => {
    const attrs: string[] = [`xmlns="${XHTML_NS}"`];
    const htmlStyle = doc.documentElement.getAttribute('style');
    const htmlClass = doc.documentElement.getAttribute('class');
    if (htmlStyle) attrs.push(`style="${htmlStyle.replace(/"/g, '&quot;')}"`);
    if (htmlClass) attrs.push(`class="${htmlClass.replace(/"/g, '&quot;')}"`);
    return `<html ${attrs.join(' ')}>`;
  })();

  const getAnimatedProps = (anim: Animation): string[] => {
    let cached = animPropsCache.get(anim);
    if (cached) return cached;

    const propSet = new Set<string>();
    const effect = anim.effect;
    if (effect && typeof (effect as KeyframeEffect).getKeyframes === 'function') {
      try {
        const frames = (effect as KeyframeEffect).getKeyframes();
        for (const frame of frames) {
          for (const key of Object.keys(frame)) {
            if (!IGNORED_KEYFRAME_PROPS.has(key)) {
              propSet.add(toKebabCase(key));
            }
          }
        }
      } catch {
        // Fallback props
      }
    }
    if (propSet.size === 0) {
      propSet.add('transform');
      propSet.add('opacity');
    }
    cached = Array.from(propSet);
    animPropsCache.set(anim, cached);
    return cached;
  };

  return {
    buildFrameSvgBlobUrl: () => {
      const currentHeadCount = doc.head ? doc.head.children.length : 0;
      if (currentHeadCount !== cachedHeadCount) {
        cachedHeadCount = currentHeadCount;
        staticHeadXml = buildStaticHeadXml();
      }

      const pseudoRules: string[] = [];
      const taggedElements: Element[] = [];
      const animStylesMap = new Map<string, Array<[string, string]>>();

      if (typeof doc.getAnimations === 'function') {
        const anims = doc.getAnimations();
        for (let i = 0; i < anims.length; i++) {
          const anim = anims[i];
          const effect = anim.effect as KeyframeEffect | null;
          const target = effect?.target;
          if (!target || target.nodeType !== 1) continue;

          const pseudo = effect?.pseudoElement || null;
          const props = getAnimatedProps(anim);
          const computed = win.getComputedStyle(target, pseudo);

          let id = target.getAttribute('data-fh-id');
          if (!id) {
            id = String(taggedElements.length);
            target.setAttribute('data-fh-id', id);
            taggedElements.push(target);
          }

          if (pseudo) {
            const decls = props
              .map((p) => {
                const val = computed.getPropertyValue(p);
                return val ? `${p}:${val} !important` : '';
              })
              .filter(Boolean)
              .join(';');
            if (decls) {
              pseudoRules.push(
                `[data-fh-id="${id}"]${pseudo}{${decls};animation:none !important;transition:none !important;}`
              );
            }
          } else {
            let list = animStylesMap.get(id);
            if (!list) {
              list = [];
              animStylesMap.set(id, list);
            }
            for (const p of props) {
              const val = computed.getPropertyValue(p);
              if (val) list.push([p, val]);
            }
          }
        }
      }

      const smilTransformMap = new Map<string, string>();
      if (hasSmilElements) {
        const smilAnimatedEls = doc.querySelectorAll('svg animate, svg animateTransform, svg animateMotion');
        const seenParents = new Set<Element>();
        smilAnimatedEls.forEach((smil) => {
          const parent = smil.parentElement;
          if (!parent || seenParents.has(parent)) return;
          seenParents.add(parent);
          const svgGraphics = parent as unknown as SVGGraphicsElement;
          if (svgGraphics.transform?.animVal) {
            const consolidated = svgGraphics.transform.animVal.consolidate();
            if (consolidated) {
              const m = consolidated.matrix;
              let id = parent.getAttribute('data-fh-id');
              if (!id) {
                id = String(taggedElements.length);
                parent.setAttribute('data-fh-id', id);
                taggedElements.push(parent);
              }
              smilTransformMap.set(id, `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`);
            }
          }
        });
      }

      const canvasDataUrls: string[] = [];
      if (hasCanvases) {
        const liveCanvases = doc.querySelectorAll('canvas');
        for (let c = 0; c < liveCanvases.length; c++) {
          try {
            canvasDataUrls.push(liveCanvases[c].toDataURL('image/png'));
          } catch {
            canvasDataUrls.push('');
          }
        }
      }

      const clonedBody = doc.body.cloneNode(true) as HTMLElement;

      for (let t = 0; t < taggedElements.length; t++) {
        taggedElements[t].removeAttribute('data-fh-id');
      }

      if (hasBodyScripts) {
        const scripts = clonedBody.querySelectorAll('script, noscript');
        for (let s = 0; s < scripts.length; s++) {
          scripts[s].remove();
        }
      }

      if (animStylesMap.size > 0 || smilTransformMap.size > 0) {
        if (clonedBody.hasAttribute('data-fh-id')) {
          const id = clonedBody.getAttribute('data-fh-id')!;
          const pairs = animStylesMap.get(id);
          if (pairs) {
            for (let p = 0; p < pairs.length; p++) {
              clonedBody.style.setProperty(pairs[p][0], pairs[p][1], 'important');
            }
          }
        }
        const clonedTagged = clonedBody.querySelectorAll('[data-fh-id]');
        for (let i = 0; i < clonedTagged.length; i++) {
          const el = clonedTagged[i] as HTMLElement | SVGElement;
          const id = el.getAttribute('data-fh-id');
          if (!id) continue;

          const pairs = animStylesMap.get(id);
          if (pairs && el.style) {
            for (let p = 0; p < pairs.length; p++) {
              el.style.setProperty(pairs[p][0], pairs[p][1], 'important');
            }
          }
          const smilMatrix = smilTransformMap.get(id);
          if (smilMatrix) {
            el.setAttribute('transform', smilMatrix);
          }
        }
      }

      if (canvasDataUrls.length > 0) {
        const clonedCanvases = clonedBody.querySelectorAll('canvas');
        for (let c = 0; c < clonedCanvases.length; c++) {
          const dataUrl = canvasDataUrls[c];
          if (!dataUrl) continue;
          const cEl = clonedCanvases[c];
          const img = doc.createElementNS(XHTML_NS, 'img') as HTMLImageElement;
          img.setAttribute('src', dataUrl);
          img.setAttribute('style', cEl.getAttribute('style') || '');
          img.className = cEl.className;
          if (!img.style.width) img.style.width = `${cEl.width}px`;
          if (!img.style.height) img.style.height = `${cEl.height}px`;
          img.style.display = cEl.style.display || 'block';
          cEl.replaceWith(img);
        }
      }

      clonedBody.setAttribute('xmlns', XHTML_NS);
      const bodyXml = serializer.serializeToString(clonedBody);

      const freezeCssText = `*,*::before,*::after{animation:none !important;transition:none !important;}${pseudoRules.join('')}`
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const freezeCss = `<style xmlns="${XHTML_NS}">${freezeCssText}</style>`;

      const svgXml =
        `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
        `<foreignObject x="0" y="0" width="100%" height="100%">` +
        `${htmlOpenTag}${staticHeadXml}${freezeCss}${bodyXml}</html>` +
        `</foreignObject></svg>`;

      const blob = new Blob([svgXml], { type: 'image/svg+xml;charset=utf-8' });
      return URL.createObjectURL(blob);
    },
  };
}

function decodeSvgBlobUrl(blobUrl: string): Promise<{ img: HTMLImageElement; blobUrl: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve({ img, blobUrl });
    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      reject(new Error('Failed to rasterize HTML frame.'));
    };
    img.src = blobUrl;
  });
}

function canvasToPngUint8Array(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to snapshot PNG frame.'));
        return;
      }
      blob
        .arrayBuffer()
        .then((buf) => resolve(new Uint8Array(buf)))
        .catch(reject);
    }, 'image/png');
  });
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (let i = 0; i < chunks.length; i++) total += chunks[i].byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], offset);
    offset += chunks[i].byteLength;
  }
  return out;
}

async function tryStartServerRender(
  width: number,
  height: number,
  fps: number,
  format: VideoFormat,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const res = await fetch('/api/render/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width, height, fps, format }),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { jobId?: string };
    return data.jobId ?? null;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return null;
  }
}

async function uploadServerFrameBatch(
  jobId: string,
  payload: Uint8Array,
  signal?: AbortSignal
): Promise<void> {
  const bodyBuffer = payload.buffer.slice(
    payload.byteOffset,
    payload.byteOffset + payload.byteLength
  ) as ArrayBuffer;
  const res = await fetch(`/api/render/${encodeURIComponent(jobId)}/frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bodyBuffer,
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Server frame upload failed (${res.status}).`);
  }
}

async function finishServerRender(jobId: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(`/api/render/${encodeURIComponent(jobId)}/finish`, {
    method: 'POST',
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `FFmpeg render failed (${res.status}).`);
  }
  return await res.blob();
}

async function pickFallbackWebCodecs(
  preferredFormat: VideoFormat,
  width: number,
  height: number,
  fps: number,
  bitrate: number
): Promise<{ container: VideoFormat; codec: string } | null> {
  if (typeof VideoEncoder === 'undefined') return null;

  // Prefer VP9 (no B-frame reordering issues) or Baseline H.264 (no B-frames) in fallback mode
  const webmCandidates = ['vp09.00.50.08', 'vp09.00.41.08', 'vp09.00.40.08', 'vp09.00.31.08', 'vp8'];
  const mp4Candidates = ['avc1.420032', 'avc1.42002a', 'avc1.420028', 'avc1.42001f', 'avc1.42E01E'];

  const order =
    preferredFormat === 'mp4'
      ? [
          { container: 'mp4' as const, candidates: mp4Candidates },
          { container: 'webm' as const, candidates: webmCandidates },
        ]
      : [
          { container: 'webm' as const, candidates: webmCandidates },
          { container: 'mp4' as const, candidates: mp4Candidates },
        ];

  for (const group of order) {
    for (const codec of group.candidates) {
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec,
          width,
          height,
          bitrate,
          framerate: fps,
        });
        if (support.supported) {
          return { container: group.container, codec };
        }
      } catch {
        // Next candidate
      }
    }
  }
  return null;
}

export async function exportHtmlAnimationToVideo(options: ExportOptions): Promise<ExportResult> {
  const renderStartedAt = performance.now();
  const width = makeEven(options.width);
  const height = makeEven(options.height);
  const fps = Math.max(1, Math.round(options.fps));
  const durationSec = Math.max(0.5, options.durationSec);
  const totalFrames = Math.max(1, Math.round(durationSec * fps));
  const frameDurationUs = Math.round(1_000_000 / fps);
  const frameIntervalMs = 1000 / fps;

  const notify = (phase: ExportProgress['phase'], frame: number) => {
    options.onProgress?.({
      phase,
      frame,
      totalFrames,
      percent: Math.min(100, Math.round((frame / totalFrames) * 100)),
    });
  };

  notify('preparing', 0);

  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-100000px';
  host.style.top = '0';
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
  host.style.overflow = 'hidden';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '-1';

  const iframe = document.createElement('iframe');
  iframe.style.width = `${width}px`;
  iframe.style.height = `${height}px`;
  iframe.style.border = '0';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.srcdoc = normalizeHtmlDocument(options.html, true);

  host.appendChild(iframe);
  document.body.appendChild(host);

  const pendingBlobUrls = new Set<string>();
  let activeJobId: string | null = null;

  try {
    if (options.signal?.aborted) {
      throw new DOMException('Export cancelled', 'AbortError');
    }

    const [doc, serverJobId] = await Promise.all([
      waitForIframeReady(iframe),
      tryStartServerRender(width, height, fps, options.format, options.signal),
    ]);
    activeJobId = serverJobId;

    const win = iframe.contentWindow as FrameClockWindow | null;

    if (options.signal?.aborted) {
      throw new DOMException('Export cancelled', 'AbortError');
    }

    const fullCanvas = findSingleFullCanvas(doc, width, height);
    const opaqueBg = resolveOpaqueBackground(doc);

    if (!fullCanvas) {
      await inlineExternalResourcesOnce(doc);
    }

    const snapshotBuilder = fullCanvas ? null : createFastDomSnapshotBuilder(doc, width, height);

    // Primary High-Quality Path: Streaming lossless PNG frames to server FFmpeg (libx264 CRF 14 / VP9)
    if (activeJobId) {
      const CANVAS_POOL_SIZE = 4;
      const canvasPool = Array.from({ length: CANVAS_POOL_SIZE }, () => {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const ctx = c.getContext('2d', { alpha: false })!;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        return { canvas: c, ctx, pending: null as Promise<Uint8Array> | null };
      });

      const BATCH_SIZE = 12;
      let batchPromises: Array<Promise<Uint8Array>> = [];
      let pendingUpload: Promise<void> = Promise.resolve();

      const flushBatch = async () => {
        if (batchPromises.length === 0) return;
        const currentBatch = batchPromises;
        batchPromises = [];
        const pngBuffers = await Promise.all(currentBatch);
        const packed = concatUint8Arrays(pngBuffers);
        await pendingUpload;
        if (options.signal?.aborted) {
          throw new DOMException('Export cancelled', 'AbortError');
        }
        pendingUpload = uploadServerFrameBatch(activeJobId!, packed, options.signal);
      };

      if (fullCanvas) {
        for (let i = 0; i < totalFrames; i++) {
          if (options.signal?.aborted) {
            throw new DOMException('Export cancelled', 'AbortError');
          }

          const slot = canvasPool[i % CANVAS_POOL_SIZE];
          if (slot.pending) {
            await slot.pending;
          }

          win?.__FRAMEHTML_CLOCK__?.advanceTo(i * frameIntervalMs);
          slot.ctx.fillStyle = opaqueBg;
          slot.ctx.fillRect(0, 0, width, height);
          slot.ctx.drawImage(fullCanvas, 0, 0, width, height);

          const pngPromise = canvasToPngUint8Array(slot.canvas);
          slot.pending = pngPromise;
          batchPromises.push(pngPromise);

          if (batchPromises.length >= BATCH_SIZE) {
            await flushBatch();
          }

          if (i % 6 === 0 || i === totalFrames - 1) {
            notify('rendering', i + 1);
            await new Promise((r) => setTimeout(r, 0));
          }
        }
      } else if (snapshotBuilder) {
        const PIPELINE_CONCURRENCY = 10;
        let nextGenerateIdx = 0;
        const decodeQueue: Array<Promise<{ img: HTMLImageElement; blobUrl: string }>> = [];

        const enqueueNextFrame = () => {
          if (nextGenerateIdx >= totalFrames) return;
          const idx = nextGenerateIdx++;
          win?.__FRAMEHTML_CLOCK__?.advanceTo(idx * frameIntervalMs);
          const blobUrl = snapshotBuilder.buildFrameSvgBlobUrl();
          pendingBlobUrls.add(blobUrl);
          decodeQueue.push(decodeSvgBlobUrl(blobUrl));
        };

        while (decodeQueue.length < PIPELINE_CONCURRENCY && nextGenerateIdx < totalFrames) {
          enqueueNextFrame();
        }

        for (let i = 0; i < totalFrames; i++) {
          if (options.signal?.aborted) {
            throw new DOMException('Export cancelled', 'AbortError');
          }

          const decodePromise = decodeQueue.shift()!;
          enqueueNextFrame();

          const { img, blobUrl } = await decodePromise;
          const slot = canvasPool[i % CANVAS_POOL_SIZE];
          if (slot.pending) {
            await slot.pending;
          }

          slot.ctx.fillStyle = opaqueBg;
          slot.ctx.fillRect(0, 0, width, height);
          slot.ctx.drawImage(img, 0, 0, width, height);
          URL.revokeObjectURL(blobUrl);
          pendingBlobUrls.delete(blobUrl);

          const pngPromise = canvasToPngUint8Array(slot.canvas);
          slot.pending = pngPromise;
          batchPromises.push(pngPromise);

          if (batchPromises.length >= BATCH_SIZE) {
            await flushBatch();
          }

          if (i % 3 === 0 || i === totalFrames - 1) {
            notify('rendering', i + 1);
          }
        }
      }

      await flushBatch();
      await pendingUpload;

      notify('finalizing', totalFrames);
      const videoBlob = await finishServerRender(activeJobId, options.signal);
      const finishedJobId = activeJobId;
      activeJobId = null;

      return {
        blob: videoBlob,
        url: URL.createObjectURL(videoBlob),
        mimeType: options.format === 'mp4' ? 'video/mp4' : 'video/webm',
        extension: options.format,
        sizeBytes: videoBlob.size,
        width,
        height,
        fps,
        durationSec,
        renderTimeMs: Math.round(performance.now() - renderStartedAt),
        encoderUsed: `ffmpeg-${options.format === 'mp4' ? 'libx264' : 'vp9'}:${finishedJobId.slice(0, 4)}`,
      };
    }

    // Fallback Path: Client-side WebCodecs (only used if server endpoint is unavailable)
    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = width;
    compositeCanvas.height = height;
    const compositeCtx = compositeCanvas.getContext('2d', { alpha: false });
    if (!compositeCtx) {
      throw new Error('Could not initialize 2D canvas context.');
    }

    const bitrate = Math.min(32_000_000, Math.max(14_000_000, Math.round(width * height * fps * 0.45)));
    const codecChoice = await pickFallbackWebCodecs(options.format, width, height, fps, bitrate);

    if (codecChoice) {
      const isMp4 = codecChoice.container === 'mp4';
      const mp4Target = isMp4 ? new Mp4Muxer.ArrayBufferTarget() : null;
      const webmTarget = !isMp4 ? new WebmMuxer.ArrayBufferTarget() : null;

      const mp4Muxer = mp4Target
        ? new Mp4Muxer.Muxer({
            target: mp4Target,
            video: { codec: 'avc', width, height, frameRate: fps },
            fastStart: 'in-memory',
          })
        : null;

      const webmMuxer = webmTarget
        ? new WebmMuxer.Muxer({
            target: webmTarget,
            video: {
              codec: codecChoice.codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8',
              width,
              height,
              frameRate: fps,
            },
          })
        : null;

      let encoderError: Error | null = null;
      const encoder = new VideoEncoder({
        output: (chunk, meta) => {
          if (mp4Muxer) mp4Muxer.addVideoChunk(chunk, meta);
          else if (webmMuxer) webmMuxer.addVideoChunk(chunk, meta);
        },
        error: (err) => {
          encoderError = err instanceof Error ? err : new Error(String(err));
        },
      });

      encoder.configure({
        codec: codecChoice.codec,
        width,
        height,
        bitrate,
        framerate: fps,
      });

      for (let i = 0; i < totalFrames; i++) {
        if (options.signal?.aborted) {
          try {
            encoder.close();
          } catch {}
          throw new DOMException('Export cancelled', 'AbortError');
        }
        if (encoderError) throw encoderError;

        win?.__FRAMEHTML_CLOCK__?.advanceTo(i * frameIntervalMs);
        compositeCtx.fillStyle = opaqueBg;
        compositeCtx.fillRect(0, 0, width, height);

        if (fullCanvas) {
          compositeCtx.drawImage(fullCanvas, 0, 0, width, height);
        } else if (snapshotBuilder) {
          const blobUrl = snapshotBuilder.buildFrameSvgBlobUrl();
          pendingBlobUrls.add(blobUrl);
          const { img } = await decodeSvgBlobUrl(blobUrl);
          compositeCtx.drawImage(img, 0, 0, width, height);
          URL.revokeObjectURL(blobUrl);
          pendingBlobUrls.delete(blobUrl);
        }

        while (encoder.encodeQueueSize > 8) {
          await new Promise((r) => setTimeout(r, 4));
        }

        const videoFrame = new VideoFrame(compositeCanvas, {
          timestamp: Math.round((i * 1_000_000) / fps),
          duration: frameDurationUs,
        });
        encoder.encode(videoFrame, { keyFrame: i % fps === 0 });
        videoFrame.close();

        if (i % 4 === 0 || i === totalFrames - 1) {
          notify('rendering', i + 1);
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      notify('finalizing', totalFrames);
      await encoder.flush();
      encoder.close();

      if (encoderError) throw encoderError;

      if (mp4Muxer && mp4Target) {
        mp4Muxer.finalize();
        const blob = new Blob([mp4Target.buffer], { type: 'video/mp4' });
        return {
          blob,
          url: URL.createObjectURL(blob),
          mimeType: 'video/mp4',
          extension: 'mp4',
          sizeBytes: blob.size,
          width,
          height,
          fps,
          durationSec,
          renderTimeMs: Math.round(performance.now() - renderStartedAt),
          encoderUsed: codecChoice.codec,
        };
      }

      if (webmMuxer && webmTarget) {
        webmMuxer.finalize();
        const blob = new Blob([webmTarget.buffer], { type: 'video/webm' });
        return {
          blob,
          url: URL.createObjectURL(blob),
          mimeType: 'video/webm',
          extension: 'webm',
          sizeBytes: blob.size,
          width,
          height,
          fps,
          durationSec,
          renderTimeMs: Math.round(performance.now() - renderStartedAt),
          encoderUsed: codecChoice.codec,
        };
      }
    }

    throw new Error('Could not initialize video encoder.');
  } finally {
    if (activeJobId) {
      fetch(`/api/render/${encodeURIComponent(activeJobId)}`, { method: 'DELETE' }).catch(() => {});
    }
    pendingBlobUrls.forEach((url) => URL.revokeObjectURL(url));
    pendingBlobUrls.clear();
    host.remove();
  }
}
