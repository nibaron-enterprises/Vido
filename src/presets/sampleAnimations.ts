export interface SamplePreset {
  id: string;
  label: string;
  html: string;
}

export const SAMPLE_PRESETS: SamplePreset[] = [
  {
    id: 'orbital-rings',
    label: 'Orbital Rings',
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 100vw;
      height: 100vh;
      display: grid;
      place-items: center;
      background: radial-gradient(circle at 50% 45%, #182235 0%, #090d16 70%);
      overflow: hidden;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .stage {
      position: relative;
      width: 360px;
      height: 360px;
      display: grid;
      place-items: center;
    }
    .ring {
      position: absolute;
      border-radius: 50%;
      border: 2px solid transparent;
    }
    .ring-1 {
      width: 320px;
      height: 320px;
      border-top-color: #38bdf8;
      border-right-color: rgba(56, 189, 248, 0.2);
      animation: spin 4s linear infinite;
    }
    .ring-2 {
      width: 240px;
      height: 240px;
      border-bottom-color: #818cf8;
      border-left-color: rgba(129, 140, 248, 0.25);
      animation: spin-rev 3s linear infinite;
    }
    .ring-3 {
      width: 160px;
      height: 160px;
      border-top-color: #f472b6;
      border-left-color: rgba(244, 114, 182, 0.25);
      animation: spin 2s linear infinite;
    }
    .core {
      width: 68px;
      height: 68px;
      border-radius: 50%;
      background: linear-gradient(135deg, #38bdf8, #818cf8);
      box-shadow: 0 0 48px rgba(56, 189, 248, 0.55);
      animation: pulse 2s ease-in-out infinite;
    }
    .dot {
      position: absolute;
      top: -6px;
      left: 50%;
      width: 12px;
      height: 12px;
      margin-left: -6px;
      border-radius: 50%;
      background: #e0f2fe;
      box-shadow: 0 0 16px #38bdf8;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes spin-rev {
      from { transform: rotate(360deg); }
      to { transform: rotate(0deg); }
    }
    @keyframes pulse {
      0%, 100% { transform: scale(0.92); opacity: 0.9; }
      50% { transform: scale(1.08); opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="stage">
    <div class="ring ring-1"><div class="dot"></div></div>
    <div class="ring ring-2"></div>
    <div class="ring ring-3"></div>
    <div class="core"></div>
  </div>
</body>
</html>`,
  },
  {
    id: 'kinetic-type',
    label: 'Kinetic Type',
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 100vw;
      height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      background: #f4f4f5;
      color: #09090b;
      font-family: system-ui, -apple-system, sans-serif;
      overflow: hidden;
    }
    .card {
      width: 78%;
      max-width: 780px;
      padding: 48px 56px;
      background: #ffffff;
      border: 1px solid #e4e4e7;
      border-radius: 20px;
      box-shadow: 0 24px 60px rgba(9, 9, 11, 0.08);
    }
    .kicker {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #2563eb;
      margin-bottom: 18px;
      animation: slideUp 0.9s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    .headline {
      font-size: 56px;
      font-weight: 700;
      line-height: 1.06;
      letter-spacing: -0.03em;
      animation: slideUp 0.9s 0.14s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    .bars {
      margin-top: 36px;
      display: flex;
      gap: 10px;
      height: 44px;
      align-items: flex-end;
    }
    .bar {
      flex: 1;
      height: 100%;
      background: #18181b;
      border-radius: 6px;
      transform-origin: bottom;
      animation: equalize 1.4s ease-in-out infinite;
    }
    .bar:nth-child(2) { animation-delay: 0.15s; background: #2563eb; }
    .bar:nth-child(3) { animation-delay: 0.3s; }
    .bar:nth-child(4) { animation-delay: 0.45s; background: #2563eb; }
    .bar:nth-child(5) { animation-delay: 0.6s; }
    .bar:nth-child(6) { animation-delay: 0.75s; }
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(28px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes equalize {
      0%, 100% { transform: scaleY(0.28); }
      50% { transform: scaleY(1); }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="kicker">Motion Sequence</div>
    <h1 class="headline">Html animation rendered straight to video.</h1>
    <div class="bars">
      <div class="bar"></div>
      <div class="bar"></div>
      <div class="bar"></div>
      <div class="bar"></div>
      <div class="bar"></div>
      <div class="bar"></div>
    </div>
  </div>
</body>
</html>`,
  },
  {
    id: 'particle-wave',
    label: 'Particle Wave',
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #09090b; }
    canvas { display: block; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <canvas id="scene"></canvas>
  <script>
    const canvas = document.getElementById('scene');
    const ctx = canvas.getContext('2d');

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    function draw(now) {
      const t = now * 0.002;
      const w = canvas.width;
      const h = canvas.height;

      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, w, h);

      const lines = 7;
      for (let l = 0; l < lines; l++) {
        ctx.beginPath();
        const hue = 200 + l * 14;
        ctx.strokeStyle = 'hsla(' + hue + ', 88%, 64%, ' + (0.25 + l * 0.1) + ')';
        ctx.lineWidth = 2.5;

        for (let x = 0; x <= w; x += 8) {
          const progress = x / w;
          const amp = (h * 0.16) * Math.sin(progress * Math.PI);
          const y = h / 2 + Math.sin(progress * 8 + t + l * 0.45) * amp
                          + Math.cos(progress * 4 - t * 0.7 + l) * (amp * 0.35);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
  </script>
</body>
</html>`,
  },
];
