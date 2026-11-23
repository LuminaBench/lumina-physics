// lumina-physics · parametric breaking tsunami (specs/03). Mirrors the shader profile on
// the CPU so buoyancy lifts and throws vessels with the visible wave.
using UnityEngine;

namespace Lumina.Physics
{
    public class LuminaTsunami : MonoBehaviour
    {
        public float height = 24f;
        public float width = 46f;
        public float direction = 0f;          // radians, 0 = +X
        public float speed = 19f;
        [Range(0f, 1f)] public float breaking = 0.85f;
        public Material oceanMaterial;

        public float Front { get; private set; } = -1e5f;
        public float Amplitude { get; private set; }
        bool running;
        float target;

        public void Launch(Vector3 at, float distance)
        {
            Front = at.x * Mathf.Cos(direction) + at.z * Mathf.Sin(direction) - distance;
            running = true;
            target = 1f;
        }

        public void Stop() => target = 0f;

        void Update()
        {
            Amplitude = Mathf.Lerp(Amplitude, target, Mathf.Min(1f, Time.deltaTime * 1.6f));
            if (running) Front += speed * Time.deltaTime;
            if (oceanMaterial == null) return;
            oceanMaterial.SetFloat("_TsunamiHeight", height * Amplitude);
            oceanMaterial.SetFloat("_TsunamiWidth", width);
            oceanMaterial.SetVector("_TsunamiDirection", new Vector4(Mathf.Cos(direction), Mathf.Sin(direction), 0, 0));
            oceanMaterial.SetFloat("_TsunamiFront", Front);
            oceanMaterial.SetFloat("_TsunamiBreaking", breaking);
        }

        Vector2 Profile(float x, float z)     // (elevation, crest)
        {
            float h0 = height * Amplitude;
            if (h0 < 1e-3f) return Vector2.zero;
            float dx = Mathf.Cos(direction), dz = Mathf.Sin(direction);
            float cross = -x * dz + z * dx;
            float s = x * dx + z * dz - Front + width * (0.12f * Mathf.Sin(cross * 0.011f + 1.3f) + 0.06f * Mathf.Sin(cross * 0.037f + 0.4f));
            float h = h0 * (1f + 0.12f * Mathf.Sin(cross * 0.017f + 0.5f));
            float wf = width * Mathf.Lerp(0.6f, 0.24f, breaking), wb = width * 1.6f;
            float c = (float)System.Math.Cosh(Mathf.Clamp(s / (s > 0f ? wf : wb), -20f, 20f));
            float crest = 1f / (c * c);
            float bore = s < 0f ? 0.3f * (1f - Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(-2.5f * wb, 0.4f * wb, s))) * Mathf.Exp(s / (12f * width)) : 0f;
            float tr = (s - 2.4f * wf) / (1.6f * wf);
            return new Vector2(h * (Mathf.Max(crest, bore) - 0.1f * Mathf.Exp(-tr * tr)), crest);
        }

        public float HeightAt(float x, float z) => Profile(x, z).x;

        /// <summary>Horizontal water velocity under the wave (solitary-wave theory).</summary>
        public Vector3 FlowAt(float x, float z, float depth = 40f)
        {
            Vector2 p = Profile(x, z);
            float d = Mathf.Clamp(depth, 2f, 40f), eta = Mathf.Max(p.x, 0f);
            float u = Mathf.Min(speed, speed * eta / (d + eta) + speed * breaking * p.y * p.y * 0.8f);
            return new Vector3(Mathf.Cos(direction) * u, 0f, Mathf.Sin(direction) * u);
        }
    }
}
