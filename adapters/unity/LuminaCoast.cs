using UnityEngine;

namespace Lumina.Physics
{
    /// <summary>Wave displacement and drying for a host-sampled shoreline in world metres.</summary>
    public static class LuminaCoast
    {
        private static float Smooth(float lo, float hi, float x)
        {
            float t = Mathf.Clamp01((x - lo) / (hi - lo));
            return t * t * (3f - 2f * t);
        }

        public static float WaveOffset(Vector4 texel, float depth, float time, float level,
                                       float strength, float period = 8.2f)
        {
            if (period <= 0f || (depth >= 2.4f && level >= texel.w + .025f)) return 0f;
            float phase = 2f * Mathf.PI * time / period - texel.x;
            float shape = .22f + .76f * Mathf.Sin(phase) + .16f * Mathf.Sin(phase * 2f - .65f);
            float envelope = strength * texel.z * (1f - Smooth(1.25f, 2.4f, depth));
            float wave = envelope * shape * (.87f + .13f * Mathf.Sin(texel.y - time * .19f));
            float reach = Smooth(-.035f, .025f, level + wave - texel.w);
            return Mathf.Lerp(Mathf.Min(wave, -depth - .045f), wave, reach);
        }

        public static float DrainFilm(float film, float dt, float drainageSeconds)
        {
            return Mathf.Clamp01(film) * Mathf.Exp(-Mathf.Max(0f, dt) / Mathf.Max(.001f, drainageSeconds));
        }
    }
}
