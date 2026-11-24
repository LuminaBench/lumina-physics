/** Record live coastal replays on a production preview. Optional args: base URL and evidence folder. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const base = process.argv[2] ?? 'http://localhost:4173';
const folder = path.resolve(process.argv[3] ?? 'qa/output/coast-films');
await mkdir(folder, { recursive: true });
const plans = [
  { id: 'three-prints', shore: 'atlantic', view: 'walk', seconds: 20 },
  { id: 'skiff', shore: 'cay', view: 'skiff', seconds: 7 },
  { id: 'basalt-pools', shore: 'volcanic', view: 'walk', seconds: 8 },
  { id: 'night-road', shore: 'boulevard', view: 'drive', seconds: 8, hour: 19.25 },
  { id: 'pier-outbound', shore: 'boulevard', view: 'drive', seconds: 7, hour: 12, driveSign: 1 },
  { id: 'pier-return', shore: 'boulevard', view: 'drive', seconds: 7, hour: 12, driveSign: -1 },
  { id: 'sunset-turn', shore: 'atlantic', view: 'walk', seconds: 10, hour: 18.7 },
  { id: 'cloud-entry', shore: 'cay', view: 'fly', seconds: 9 },
];
const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=default'],
});
try {
  for (const plan of plans) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (line) => {
      if (line.type() === 'error' && !line.text().includes('favicon')) errors.push(line.text());
    });
    const url = new URL('/coast.html', base);
    url.search = new URLSearchParams({
      clean: '1',
      shore: plan.shore,
      view: plan.view,
      tier: 'high',
    }).toString();
    await page.goto(url.href);
    await page.waitForFunction(() => window.coastDemo?.world.engine.stats.frames > 6, null, {
      timeout: 90000,
    });
    if (plan.id === 'cloud-entry')
      await page.waitForFunction(
        () => {
          const w = window.coastDemo.world;
          return w.engine.camera.position.y > w.weather.params.cloudBase - 65;
        },
        null,
        { timeout: 90000 },
      );
    if (plan.driveSign) {
      await page.locator('canvas').focus();
      await page.keyboard.down('w');
    }
    const manifest = await page.evaluate(async (plan) => {
      const d = window.coastDemo,
        w = d.world,
        e = w.engine,
        T = window.THREE;
      if (plan.view === 'walk') d.reset(true);
      if (plan.hour !== undefined) {
        const slider = document.getElementById('clock');
        slider.value = String(plan.hour);
        slider.dispatchEvent(new Event('input'));
      }
      if (plan.driveSign) {
        const car = d.vehicles.car,
          sign = plan.driveSign;
        const x = d.road.road.x - 0.38,
          z = d.road.layout.pier.z - sign * 25;
        car.chassis.setTranslation({ x, y: d.road.heightAt(x, z) + 0.55, z }, true);
        car.chassis.setRotation({ x: 0, y: sign < 0 ? 1 : 0, z: 0, w: sign < 0 ? 0 : 1 }, true);
        car.chassis.setLinvel({ x: 0, y: 0, z: sign * 8 }, true);
        car.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
        e.physics.snap(car.chassis);
      }
      const film = e.canvas.captureStream(24);
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      );
      const rec = new MediaRecorder(film, { mimeType, videoBitsPerSecond: 4500000 }),
        chunks = [];
      rec.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      const stopped = new Promise((ok, fail) => {
        rec.onstop = ok;
        rec.onerror = (event) => fail(new Error(event.error?.message ?? 'Recording failed'));
      });
      if (plan.id === 'sunset-turn') {
        const origin = e.time,
          sun = w.weather.sunDirection,
          angle = Math.atan2(sun.x, sun.z);
        const eye = d.prints[2].clone();
        eye.y += 1.57;
        const aim = new T.Vector3();
        e.onBeforeRender = () => {
          const h = angle + Math.PI * T.MathUtils.smoothstep(e.time - origin, 1, 8);
          e.camera.position.copy(eye);
          e.camera.lookAt(aim.set(Math.sin(h), 0.035, Math.cos(h)).add(eye));
        };
      }
      const datum = () => ({
        time: e.time,
        position: e.camera.position.toArray(),
        quaternion: e.camera.quaternion.toArray(),
        scale: e.stats.renderScale,
        prints: d.prints.map((p) => {
          const v = w.sediment.inspect(p.x, p.z);
          return { relief: v.relief, water: v.water, source: v.lastWet };
        }),
        vehicle: d.vehicles.car
          ? {
              position: d.vehicles.car.root.position.toArray(),
              wheels: d.vehicles.car.wheels.map((_, i) => d.vehicles.inspectWheel(i)),
            }
          : undefined,
        cloud: w.weather.sampleCloudDensity(e.camera.position),
        sun: w.inspect(e.camera.position.x, e.camera.position.z).sun,
      });
      const start = e.time,
        samples = [datum()],
        images = [];
      let at = 1,
        frame = 0;
      rec.start();
      await new Promise((resolve) => {
        function step() {
          const t = e.time - start;
          frame++;
          if (t >= at) {
            samples.push(datum());
            at += 1;
          }
          if (t >= plan.seconds) resolve();
          else requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      });
      rec.stop();
      await stopped;
      for (const track of film.getTracks()) track.stop();
      const blob = new Blob(chunks, { type: rec.mimeType });
      const encoded = await new Promise((r) => {
        const reader = new FileReader();
        reader.onload = () => r(reader.result);
        reader.readAsDataURL(blob);
      });
      // Decode the recorded stream at separated times and extract pictures from the delivered frames.
      const vid = document.createElement('video');
      vid.muted = true;
      const blobURL = URL.createObjectURL(blob);
      vid.src = blobURL;
      await new Promise((r, j) => {
        vid.onloadeddata = r;
        vid.onerror = () => j(Error('Recorded clip cannot be decoded'));
      });
      const canvas = document.createElement('canvas');
      canvas.width = vid.videoWidth;
      canvas.height = vid.videoHeight;
      const ctx = canvas.getContext('2d');
      // Some Chromium MediaRecorder streams omit seekable duration. Stepping through playback works for both.
      vid.playbackRate = 8;
      const sampleTimes =
        plan.id === 'three-prints'
          ? [0.5, 6, 12, 19]
          : [0.3, Math.min(4, plan.seconds * 0.5), plan.seconds - 1];
      await vid.play();
      for (const t of sampleTimes) {
        await new Promise((resolve) => {
          function check() {
            if (vid.ended || vid.currentTime >= t) resolve();
            else requestAnimationFrame(check);
          }
          check();
        });
        ctx.drawImage(vid, 0, 0);
        images.push(canvas.toDataURL('image/webp', 0.9).split(',')[1]);
      }
      vid.pause();
      vid.removeAttribute('src');
      vid.load();
      URL.revokeObjectURL(blobURL);
      return {
        video: encoded.split(',')[1],
        images,
        sampleTimes,
        frames: frame,
        samples,
        bytes: blob.size,
        codec: rec.mimeType,
        seed: w.coast.seed,
        hour: Number(document.getElementById('clock').value),
        size: [canvas.width, canvas.height],
        backend: e.backend,
        fov: e.camera.fov,
        look: w.look,
        controls: plan.driveSign ? 'W held, real wheel dynamics' : 'Authored playable replay',
        exposure: w.weather.params.exposure,
      };
    }, plan);
    if (plan.driveSign) await page.keyboard.up('w');
    const { video, images, ...data } = manifest;
    if (
      data.size[0] !== 1920 ||
      data.size[1] !== 1080 ||
      data.bytes < 60000 ||
      new Set(images).size < 2 ||
      errors.length
    )
      throw Error(plan.id + ': ' + JSON.stringify({ size: data.size, bytes: data.bytes, errors }));
    await writeFile(path.join(folder, plan.id + '.webm'), Buffer.from(video, 'base64'));
    for (let i = 0; i < images.length; i++)
      await writeFile(path.join(folder, plan.id + '-' + i + '.webp'), Buffer.from(images[i], 'base64'));
    await writeFile(
      path.join(folder, plan.id + '.json'),
      JSON.stringify({ ...plan, ...data, errors }, null, 2),
    );
    console.log(
      plan.id,
      data.bytes,
      data.frames,
      data.samples.at(-1).prints.map((p) => p.relief),
    );
    await page.close();
  }
  // Same physical instant and camera for each palette. Capture the same ground patch at three distances.
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  try {
    await page.goto(new URL('/coast.html?shore=atlantic&view=walk&clean=1&tier=high', base).href);
    await page.waitForFunction(() => window.coastDemo?.world.engine.stats.frames > 5, null, {
      timeout: 90000,
    });
    await page.evaluate(() => {
      const d = window.coastDemo,
        e = d.world.engine;
      e.stop();
      d.reset(true);
      e.paused = true;
      e.onUpdate = e.onBeforeRender = null;
    });
    const views = [];
    for (const shot of [
      ['boot', 'natural-daylight', 0.42, 1.05],
      ['driver', 'natural-daylight', 1.5, 3.1],
      ['low-pass', 'natural-daylight', 12, 29],
      ['natural', 'natural-daylight', 1.6, 6],
      ['graphic', 'painterly', 1.6, 6],
      ['noir', 'neon-night', 1.6, 6],
    ]) {
      const row = await page.evaluate(async ([name, look, height, distance]) => {
        const d = window.coastDemo,
          w = d.world,
          e = w.engine,
          p = d.prints[1],
          T = window.THREE;
        const along = w.coast.project(0, 0).along,
          eye = w.coast.point(along - distance * 0.52, 8.25 + distance);
        e.camera.position.set(eye.x, w.ground(eye.x, eye.z) + height, eye.z);
        const target = p.clone();
        if (['natural', 'graphic', 'noir'].includes(name)) {
          const pier = d.road.layout.pier;
          target.set(pier.x, 1.6, pier.z);
        }
        e.camera.lookAt(target);
        w.setFocus(p);
        w.sediment.update(0, p.x, p.z, w.ocean.waterLevel, w.ocean.optics.breakerHeight);
        w.sand.update(p.x, p.z, true);
        w.setLook(look);
        w.optics.update(0.5);
        for (let i = 0; i < 20; i++) {
          e.tick(performance.now());
          await new Promise(requestAnimationFrame);
        }
        return {
          name,
          look,
          position: e.camera.position.toArray(),
          rotation: e.camera.quaternion.toArray(),
          ground: w.ground(p.x, p.z),
          relief: w.sediment.inspect(p.x, p.z).relief,
          time: e.time,
        };
      }, shot);
      await page.screenshot({ path: path.join(folder, row.name + '.jpg'), quality: 90 });
      views.push(row);
    }
    for (const row of views.slice(-2))
      for (const key of ['position', 'rotation', 'ground', 'relief', 'time'])
        if (JSON.stringify(row[key]) !== JSON.stringify(views[3][key]))
          throw Error('Style comparison changed ' + key);
    await writeFile(path.join(folder, 'views.json'), JSON.stringify(views, null, 2));
  } finally {
    await page.close();
  }
} finally {
  await browser.close();
}
