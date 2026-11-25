import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClipboardPaste,
  Download,
  Film,
  Play,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { normalizeHtmlDocument } from './engine/htmlNormalizer';
import {
  exportHtmlAnimationToVideo,
  type ExportProgress,
  type ExportResult,
  type VideoFormat,
} from './engine/videoExporter';
import { SAMPLE_PRESETS } from './presets/sampleAnimations';

interface ResolutionPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

const RESOLUTIONS: ResolutionPreset[] = [
  { id: '720p', label: '720p', width: 1280, height: 720 },
  { id: '1080p', label: '1080p', width: 1920, height: 1080 },
  { id: 'square', label: '1:1', width: 1080, height: 1080 },
  { id: 'vertical', label: '9:16', width: 1080, height: 1920 },
];

const DURATIONS = [3, 5, 8, 12];
const FPS_OPTIONS = [30, 60];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function triggerDownload(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export default function App() {
  const [html, setHtml] = useState<string>(SAMPLE_PRESETS[0].html);
  const [debouncedHtml, setDebouncedHtml] = useState<string>(SAMPLE_PRESETS[0].html);
  const [activePresetId, setActivePresetId] = useState<string | null>(SAMPLE_PRESETS[0].id);

  const [resolutionId, setResolutionId] = useState<string>('720p');
  const [durationSec, setDurationSec] = useState<number>(5);
  const [fps, setFps] = useState<number>(30);
  const [format, setFormat] = useState<VideoFormat>('mp4');

  const [previewKey, setPreviewKey] = useState<number>(0);
  const [stageMode, setStageMode] = useState<'live' | 'video'>('live');
  const [isDraggingFile, setIsDraggingFile] = useState<boolean>(false);

  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pasteFeedback, setPasteFeedback] = useState<string | null>(null);

  const stageContainerRef = useRef<HTMLDivElement | null>(null);
  const [stageBounds, setStageBounds] = useState<{ width: number; height: number }>({
    width: 640,
    height: 360,
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const previousUrlRef = useRef<string | null>(null);

  const resolution = useMemo(
    () => RESOLUTIONS.find((r) => r.id === resolutionId) ?? RESOLUTIONS[0],
    [resolutionId]
  );

  // Debounce live preview updates while typing
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedHtml(html);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [html]);

  // Measure preview stage so iframe scales cleanly to exact aspect ratio
  useEffect(() => {
    const node = stageContainerRef.current;
    if (!node) return;

    const updateBounds = () => {
      const rect = node.getBoundingClientRect();
      setStageBounds({
        width: Math.max(120, rect.width - 48),
        height: Math.max(120, rect.height - 48),
      });
    };

    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Revoke object URLs on replacement or unmount
  useEffect(() => {
    return () => {
      if (previousUrlRef.current) {
        URL.revokeObjectURL(previousUrlRef.current);
      }
    };
  }, []);

  const previewScale = useMemo(() => {
    const scaleX = stageBounds.width / resolution.width;
    const scaleY = stageBounds.height / resolution.height;
    return Math.min(scaleX, scaleY, 1);
  }, [stageBounds, resolution]);

  const previewSrcDoc = useMemo(
    () => normalizeHtmlDocument(debouncedHtml, false),
    [debouncedHtml]
  );

  const hasCode = html.trim().length > 0;
  const lineCount = useMemo(() => (html ? html.split('\n').length : 0), [html]);
  const totalFrames = Math.round(durationSec * fps);

  const applyNewHtml = useCallback((nextHtml: string, presetId: string | null = null) => {
    setHtml(nextHtml);
    setDebouncedHtml(nextHtml);
    setActivePresetId(presetId);
    setStageMode('live');
    setErrorMessage(null);
    setPreviewKey((k) => k + 1);
  }, []);

  const handleSelectPreset = (presetId: string) => {
    const preset = SAMPLE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    applyNewHtml(preset.html, preset.id);
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setPasteFeedback('Clipboard is empty');
        setTimeout(() => setPasteFeedback(null), 1800);
        return;
      }
      applyNewHtml(text, null);
      setPasteFeedback('Pasted');
      setTimeout(() => setPasteFeedback(null), 1500);
    } catch {
      setPasteFeedback('Use Ctrl/Cmd+V in editor');
      setTimeout(() => setPasteFeedback(null), 2200);
    }
  };

  const handleFileUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        applyNewHtml(reader.result, null);
      }
    };
    reader.readAsText(file);
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const next = html.slice(0, start) + '  ' + html.slice(end);
      setHtml(next);
      setActivePresetId(null);
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      });
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFileUpload(file);
    }
  };

  const handleExport = async () => {
    if (!hasCode || isExporting) return;

    setErrorMessage(null);
    setIsExporting(true);
    setProgress({ phase: 'preparing', frame: 0, totalFrames, percent: 0 });

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const result = await exportHtmlAnimationToVideo({
        html,
        width: resolution.width,
        height: resolution.height,
        fps,
        durationSec,
        format,
        signal: controller.signal,
        onProgress: (p) => setProgress(p),
      });

      if (previousUrlRef.current) {
        URL.revokeObjectURL(previousUrlRef.current);
      }
      previousUrlRef.current = result.url;
      setExportResult(result);
      setStageMode('video');

      triggerDownload(result.url, `animation-${result.width}x${result.height}.${result.extension}`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setErrorMessage(null);
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to convert HTML animation to video.'
        );
      }
    } finally {
      abortControllerRef.current = null;
      setIsExporting(false);
    }
  };

  const handleCancelExport = () => {
    abortControllerRef.current?.abort();
  };

  const handleDownloadAgain = () => {
    if (!exportResult) return;
    triggerDownload(
      exportResult.url,
      `animation-${exportResult.width}x${exportResult.height}.${exportResult.extension}`
    );
  };

  return (
    <div className="min-h-screen lg:h-screen flex flex-col bg-zinc-50 text-zinc-950">
      {/* Top Bar: 3-zone contract */}
      <header className="h-14 shrink-0 border-b border-zinc-200 bg-white px-5 flex items-center justify-between gap-8">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            handleSelectPreset(SAMPLE_PRESETS[0].id);
          }}
          className="text-base font-bold tracking-tight text-zinc-950 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
        >
          FrameHTML
        </a>

        <nav
          aria-label="Sample animations"
          className="hidden md:flex items-center gap-6 text-sm font-medium"
        >
          {SAMPLE_PRESETS.map((preset) => {
            const isActive = activePresetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleSelectPreset(preset.id)}
                disabled={isExporting}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer border-b-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                  isActive
                    ? 'border-zinc-950 text-zinc-950'
                    : 'border-transparent text-zinc-500 hover:text-zinc-900'
                } disabled:opacity-50`}
              >
                {preset.label}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          {isExporting ? (
            <button
              type="button"
              onClick={handleCancelExport}
              className="px-4 py-2 text-xs font-semibold text-zinc-800 bg-zinc-100 hover:bg-zinc-200 border border-zinc-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-1.5"
            >
              <X className="w-3.5 h-3.5" />
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={handleExport}
              disabled={!hasCode}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-300 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              <Film className="w-3.5 h-3.5" />
              Export Video
            </button>
          )}
        </div>
      </header>

      {/* Main Split Workspace */}
      <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12">
        {/* Left Pane: HTML Code Input */}
        <section
          aria-label="HTML Code Input"
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingFile(true);
          }}
          onDragLeave={() => setIsDraggingFile(false)}
          onDrop={handleDrop}
          className="lg:col-span-5 flex flex-col min-h-[380px] lg:min-h-0 bg-white border-b lg:border-b-0 lg:border-r border-zinc-200 relative"
        >
          <div className="px-4 py-2.5 border-b border-zinc-200 flex items-center justify-between gap-3">
            <h1 className="text-sm font-semibold text-zinc-900 whitespace-nowrap">HTML Code</h1>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handlePasteFromClipboard}
                className="px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:text-zinc-950 hover:bg-zinc-100 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-1.5"
              >
                <ClipboardPaste className="w-3.5 h-3.5" />
                {pasteFeedback ?? 'Paste'}
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:text-zinc-950 hover:bg-zinc-100 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-1.5"
              >
                <Upload className="w-3.5 h-3.5" />
                Upload .html
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".html,.htm,.svg,.txt"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileUpload(file);
                  e.target.value = '';
                }}
              />

              <button
                type="button"
                onClick={() => applyNewHtml('', null)}
                disabled={!hasCode || isExporting}
                aria-label="Clear HTML code"
                className="px-2.5 py-1.5 text-xs font-medium text-zinc-500 hover:text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:pointer-events-none rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 relative">
            <textarea
              value={html}
              onChange={(e) => {
                setHtml(e.target.value);
                setActivePresetId(null);
              }}
              onKeyDown={handleEditorKeyDown}
              spellCheck={false}
              placeholder="Paste any HTML, CSS @keyframes, SVG, or Canvas animation code here..."
              aria-label="HTML animation source code"
              className="w-full h-full resize-none p-4 font-mono text-[13px] leading-6 text-zinc-900 bg-white placeholder:text-zinc-400 focus:outline-none"
            />

            {isDraggingFile && (
              <div className="absolute inset-0 bg-blue-50/95 border-2 border-dashed border-blue-600 flex items-center justify-center pointer-events-none">
                <p className="text-sm font-semibold text-blue-700">Drop .html file to load</p>
              </div>
            )}
          </div>

          <div className="px-4 py-2 border-t border-zinc-200 bg-zinc-50/60 flex items-center justify-between gap-4 text-xs text-zinc-500">
            <span className="truncate">HTML, CSS keyframes, SVG &amp; Canvas supported</span>
            <span className="font-mono tabular-nums whitespace-nowrap shrink-0">
              {lineCount} lines · {html.length.toLocaleString()} chars
            </span>
          </div>
        </section>

        {/* Right Pane: Live Preview & Export */}
        <section
          aria-label="Animation Preview and Video Export"
          className="lg:col-span-7 flex flex-col min-h-[480px] lg:min-h-0 bg-zinc-50"
        >
          {/* Compact Controls Bar */}
          <div className="px-4 py-2.5 border-b border-zinc-200 bg-white flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-4">
              {/* Size */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-zinc-500">Size</span>
                <div className="flex items-center bg-zinc-100 p-0.5 rounded-lg border border-zinc-200">
                  {RESOLUTIONS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      disabled={isExporting}
                      onClick={() => setResolutionId(preset.id)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        resolutionId === preset.id
                          ? 'bg-white text-zinc-950 shadow-xs'
                          : 'text-zinc-600 hover:text-zinc-900'
                      } disabled:opacity-50`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Duration */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-zinc-500">Duration</span>
                <div className="flex items-center bg-zinc-100 p-0.5 rounded-lg border border-zinc-200">
                  {DURATIONS.map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      disabled={isExporting}
                      onClick={() => setDurationSec(sec)}
                      className={`px-2.5 py-1 text-xs font-medium font-mono tabular-nums rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        durationSec === sec
                          ? 'bg-white text-zinc-950 shadow-xs'
                          : 'text-zinc-600 hover:text-zinc-900'
                      } disabled:opacity-50`}
                    >
                      {sec}s
                    </button>
                  ))}
                </div>
              </div>

              {/* FPS */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-zinc-500">FPS</span>
                <div className="flex items-center bg-zinc-100 p-0.5 rounded-lg border border-zinc-200">
                  {FPS_OPTIONS.map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      disabled={isExporting}
                      onClick={() => setFps(rate)}
                      className={`px-2.5 py-1 text-xs font-medium font-mono tabular-nums rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        fps === rate
                          ? 'bg-white text-zinc-950 shadow-xs'
                          : 'text-zinc-600 hover:text-zinc-900'
                      } disabled:opacity-50`}
                    >
                      {rate}
                    </button>
                  ))}
                </div>
              </div>

              {/* Format */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-zinc-500">Format</span>
                <div className="flex items-center bg-zinc-100 p-0.5 rounded-lg border border-zinc-200">
                  {(['mp4', 'webm'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      disabled={isExporting}
                      onClick={() => setFormat(fmt)}
                      className={`px-2.5 py-1 text-xs font-medium uppercase rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        format === fmt
                          ? 'bg-white text-zinc-950 shadow-xs'
                          : 'text-zinc-600 hover:text-zinc-900'
                      } disabled:opacity-50`}
                    >
                      {fmt}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Preview Stage */}
          <div
            ref={stageContainerRef}
            className="flex-1 min-h-0 studio-stage-grid bg-zinc-100 p-6 flex flex-col items-center justify-center relative overflow-hidden"
          >
            {hasCode && (
              <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
                {exportResult && (
                  <div className="flex items-center bg-white/95 backdrop-blur-xs p-0.5 rounded-lg border border-zinc-200 shadow-xs">
                    <button
                      type="button"
                      onClick={() => setStageMode('live')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                        stageMode === 'live'
                          ? 'bg-zinc-950 text-white'
                          : 'text-zinc-600 hover:text-zinc-950'
                      }`}
                    >
                      Live HTML
                    </button>
                    <button
                      type="button"
                      onClick={() => setStageMode('video')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                        stageMode === 'video'
                          ? 'bg-zinc-950 text-white'
                          : 'text-zinc-600 hover:text-zinc-950'
                      }`}
                    >
                      Exported Video
                    </button>
                  </div>
                )}

                {stageMode === 'live' && (
                  <button
                    type="button"
                    onClick={() => setPreviewKey((k) => k + 1)}
                    className="px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:text-zinc-950 bg-white/95 hover:bg-white border border-zinc-200 rounded-lg shadow-xs transition-colors whitespace-nowrap cursor-pointer inline-flex items-center gap-1.5"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Replay
                  </button>
                )}
              </div>
            )}

            {!hasCode ? (
              <div className="text-center max-w-sm">
                <p className="text-sm font-medium text-zinc-700">
                  Paste HTML code or drop an .html file to preview
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  Works directly in your browser with no sign-up required.
                </p>
                <button
                  type="button"
                  onClick={() => handleSelectPreset(SAMPLE_PRESETS[0].id)}
                  className="mt-4 px-4 py-2 text-xs font-semibold text-zinc-900 bg-white hover:bg-zinc-50 border border-zinc-300 rounded-lg transition-colors cursor-pointer inline-flex items-center gap-1.5"
                >
                  <Play className="w-3.5 h-3.5" />
                  Load Sample Animation
                </button>
              </div>
            ) : stageMode === 'video' && exportResult ? (
              <div
                style={{
                  width: Math.round(resolution.width * previewScale),
                  height: Math.round(resolution.height * previewScale),
                }}
                className="bg-black rounded-md overflow-hidden border border-zinc-300 shadow-lg"
              >
                <video
                  key={exportResult.url}
                  src={exportResult.url}
                  controls
                  autoPlay
                  loop
                  playsInline
                  className="w-full h-full object-contain"
                />
              </div>
            ) : (
              <div
                style={{
                  width: Math.round(resolution.width * previewScale),
                  height: Math.round(resolution.height * previewScale),
                }}
                className="relative bg-white rounded-md overflow-hidden border border-zinc-300 shadow-lg"
              >
                <iframe
                  key={`${previewKey}-${resolution.width}x${resolution.height}`}
                  title="HTML animation preview"
                  sandbox="allow-scripts allow-same-origin"
                  srcDoc={previewSrcDoc}
                  style={{
                    width: resolution.width,
                    height: resolution.height,
                    transform: `scale(${previewScale})`,
                    transformOrigin: 'top left',
                  }}
                  className="border-0 block"
                />
              </div>
            )}

            {hasCode && (
              <div className="mt-3 text-xs text-zinc-500 font-mono tabular-nums">
                {resolution.width} × {resolution.height} · {fps} fps · {durationSec}s
              </div>
            )}
          </div>

          {/* Error Banner */}
          {errorMessage && (
            <div
              role="alert"
              className="px-5 py-2.5 bg-red-50 border-t border-red-200 flex items-center justify-between gap-4 text-xs text-red-700"
            >
              <span>Error: {errorMessage}</span>
              <button
                type="button"
                onClick={() => setErrorMessage(null)}
                className="font-medium underline cursor-pointer shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Bottom Export & Download Bar */}
          <div className="px-5 py-3.5 border-t border-zinc-200 bg-white flex flex-wrap items-center justify-between gap-4">
            {isExporting && progress ? (
              <>
                <div className="flex-1 min-w-[200px] flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs text-zinc-700 font-medium">
                    <span>
                      {progress.phase === 'preparing' && 'Preparing animation...'}
                      {progress.phase === 'rendering' &&
                        `Rendering frame ${progress.frame} of ${progress.totalFrames}`}
                      {progress.phase === 'finalizing' && 'Finalizing video file...'}
                    </span>
                    <span className="font-mono tabular-nums text-zinc-500">
                      {progress.percent}%
                    </span>
                  </div>
                  <div className="h-2 w-full bg-zinc-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-600 transition-[width] duration-150 ease-out"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCancelExport}
                  className="px-4 py-2 text-xs font-semibold text-zinc-800 bg-zinc-100 hover:bg-zinc-200 border border-zinc-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Cancel
                </button>
              </>
            ) : exportResult ? (
              <>
                <div className="flex items-center gap-2 text-xs text-zinc-600 font-mono tabular-nums">
                  <span className="font-sans font-medium text-emerald-700">Video ready</span>
                  <span aria-hidden="true">·</span>
                  <span className="uppercase">{exportResult.extension}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatBytes(exportResult.sizeBytes)}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {exportResult.width}×{exportResult.height}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{(exportResult.renderTimeMs / 1000).toFixed(1)}s</span>
                </div>

                <div className="flex items-center gap-2.5 shrink-0">
                  <button
                    type="button"
                    onClick={handleExport}
                    disabled={!hasCode}
                    className="px-3.5 py-2 text-xs font-medium text-zinc-700 hover:text-zinc-950 bg-zinc-100 hover:bg-zinc-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Re-export
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadAgain}
                    className="px-4 py-2 text-xs font-semibold text-white bg-zinc-950 hover:bg-zinc-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download {exportResult.extension.toUpperCase()}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="text-xs text-zinc-500 font-mono tabular-nums">
                  {durationSec}s · {fps} fps · {totalFrames} frames · {format.toUpperCase()}
                </div>
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={!hasCode}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-300 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export &amp; Download
                </button>
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
