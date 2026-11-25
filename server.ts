import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

interface RenderJob {
  id: string;
  format: 'mp4' | 'webm';
  outputPath: string;
  ffmpeg: ChildProcessByStdio<Writable, null, Readable>;
  stderrTail: string;
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  createdAt: number;
  finished: boolean;
}

const jobs = new Map<string, RenderJob>();

function cleanupJob(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return;
  jobs.delete(jobId);
  try {
    if (!job.ffmpeg.killed) {
      job.ffmpeg.kill('SIGKILL');
    }
  } catch {
    // Ignore kill errors
  }
  fs.promises.unlink(job.outputPath).catch(() => {});
}

// Reap stale render jobs older than 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff) {
      cleanupJob(id);
    }
  }
}, 60 * 1000).unref();

function clampEvenDimension(val: unknown, fallback: number): number {
  const n = Math.round(Number(val) || fallback);
  const clamped = Math.max(64, Math.min(3840, n));
  return clamped % 2 === 0 ? clamped : clamped + 1;
}

async function startServer() {
  const app = express();

  app.post('/api/render/start', express.json({ limit: '16kb' }), (req, res) => {
    const width = clampEvenDimension(req.body?.width, 1280);
    const height = clampEvenDimension(req.body?.height, 720);
    const fps = Math.max(1, Math.min(120, Math.round(Number(req.body?.fps) || 30)));
    const format: 'mp4' | 'webm' = req.body?.format === 'webm' ? 'webm' : 'mp4';

    const jobId = randomUUID();
    const outputPath = path.join(os.tmpdir(), `framehtml-${jobId}.${format}`);

    const args =
      format === 'mp4'
        ? [
            '-y',
            '-f',
            'png_pipe',
            '-framerate',
            String(fps),
            '-i',
            'pipe:0',
            '-vf',
            `scale=${width}:${height}:flags=lanczos`,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '14',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
            outputPath,
          ]
        : [
            '-y',
            '-f',
            'png_pipe',
            '-framerate',
            String(fps),
            '-i',
            'pipe:0',
            '-vf',
            `scale=${width}:${height}:flags=lanczos`,
            '-c:v',
            'libvpx-vp9',
            '-crf',
            '18',
            '-b:v',
            '0',
            '-deadline',
            'realtime',
            '-cpu-used',
            '4',
            '-row-mt',
            '1',
            '-pix_fmt',
            'yuv420p',
            outputPath,
          ];

    const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderrTail = '';

    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-1200);
      const current = jobs.get(jobId);
      if (current) current.stderrTail = stderrTail;
    });

    ffmpeg.stdin.on('error', () => {
      // Handled by exitPromise / write checks
    });

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        ffmpeg.on('close', (code, signal) => {
          resolve({ code, signal });
        });
        ffmpeg.on('error', () => {
          resolve({ code: 1, signal: null });
        });
      }
    );

    jobs.set(jobId, {
      id: jobId,
      format,
      outputPath,
      ffmpeg,
      stderrTail,
      exitPromise,
      createdAt: Date.now(),
      finished: false,
    });

    res.json({ jobId });
  });

  app.post(
    '/api/render/:id/frames',
    express.raw({ type: 'application/octet-stream', limit: '64mb' }),
    async (req, res) => {
      const job = jobs.get(req.params.id);
      if (!job || job.finished) {
        res.status(404).json({ error: 'Render job not found.' });
        return;
      }

      const payload = req.body as Buffer;
      if (!Buffer.isBuffer(payload) || payload.length === 0) {
        res.status(400).json({ error: 'Empty frame batch.' });
        return;
      }

      try {
        if (!job.ffmpeg.stdin.writable) {
          res.status(500).json({ error: 'Encoder stream closed unexpectedly.' });
          return;
        }
        const canContinue = job.ffmpeg.stdin.write(payload);
        if (!canContinue) {
          await once(job.ffmpeg.stdin, 'drain');
        }
        res.status(204).end();
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Failed to write frames to encoder.',
        });
      }
    }
  );

  app.post('/api/render/:id/finish', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.finished) {
      res.status(404).json({ error: 'Render job not found.' });
      return;
    }

    job.finished = true;

    try {
      if (job.ffmpeg.stdin.writable) {
        job.ffmpeg.stdin.end();
      }

      const { code } = await job.exitPromise;
      if (code !== 0) {
        cleanupJob(job.id);
        res.status(500).json({
          error: `FFmpeg exited with code ${code}: ${job.stderrTail.slice(-300)}`,
        });
        return;
      }

      const stat = await fs.promises.stat(job.outputPath);
      res.setHeader('Content-Type', job.format === 'mp4' ? 'video/mp4' : 'video/webm');
      res.setHeader('Content-Length', String(stat.size));

      const stream = fs.createReadStream(job.outputPath);
      stream.on('close', () => cleanupJob(job.id));
      stream.on('error', () => cleanupJob(job.id));
      stream.pipe(res);
    } catch (err) {
      cleanupJob(job.id);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to finalize encoded video.',
      });
    }
  });

  app.delete('/api/render/:id', (req, res) => {
    cleanupJob(req.params.id);
    res.status(204).end();
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

startServer();
