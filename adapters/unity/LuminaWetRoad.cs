// lumina-physics · CPU twin of Lumina/WetRoad (specs/05): PuddleDepth(x, z) returns
// exactly the standing-water depth the shader draws.
using UnityEngine;

namespace Lumina.Physics
{
    public class LuminaWetRoad : MonoBehaviour
    {
        const float Tile = 48f;
        float halfWidth = 7.5f;
        static readonly float[] RutCentres = { -2.75f, -1.05f, 1.05f, 2.75f };
        const int Packets = 24;
        readonly Vector4[] events = new Vector4[Packets], waves = new Vector4[Packets];
        int first, count;
        float clock;
        bool dirty = true;
        Material boundMaterial;
        Renderer roadRenderer;
        MaterialPropertyBlock overrides;

        void Awake()
        {
            roadRenderer = GetComponent<Renderer>();
            overrides = new MaterialPropertyBlock();
        }


        [Range(0f, 1f)] public float flood = 0.6f;
        [Range(0f, 1f)] public float wetness = 1f;
        [Range(0f, 1f)] public float rain = 0.8f;
        [Tooltip("Readable, seamless relief texture assigned to the road material.")]
        public Texture2D relief;
        public Material material;

        void Update()
        {
            if (count > 0)
            {
                clock += Time.deltaTime;
                while (count > 0 && clock - events[first].z >= 1.8f)
                {
                    first = (first + 1) % Packets;
                    count--;
                    dirty = true;
                }
                if (count == 0) clock = 0f;
            }
            var target = material != null ? material : (roadRenderer != null ? roadRenderer.sharedMaterial : null);
            if (target == null) return;
            bool perRenderer = roadRenderer != null && roadRenderer.sharedMaterial == target;
            if (perRenderer) roadRenderer.GetPropertyBlock(overrides);
            halfWidth = Mathf.Max(0.01f, target.GetFloat("_HalfWidth"));
            if (boundMaterial != target) { boundMaterial = target; dirty = true; }
            if (count > 0 || dirty)
            {
                if (perRenderer) overrides.SetFloat("_WaveClock", clock);
                else target.SetFloat("_WaveClock", clock);
            }
            if (dirty)
            {
                if (perRenderer)
                {
                    overrides.SetFloat("_WaveFirst", first);
                    overrides.SetFloat("_WaveCount", count);
                    if (count > 0)
                    {
                        overrides.SetVectorArray("_WaveEvents", events);
                        overrides.SetVectorArray("_WaveDispersion", waves);
                    }
                }
                else
                {
                    target.SetFloat("_WaveFirst", first);
                    target.SetFloat("_WaveCount", count);
                    if (count > 0)
                    {
                        target.SetVectorArray("_WaveEvents", events);
                        target.SetVectorArray("_WaveDispersion", waves);
                    }
                }
                dirty = false;
            }
            if (perRenderer)
            {
                overrides.SetFloat("_Flood", flood);
                overrides.SetFloat("_Wetness", wetness);
                overrides.SetFloat("_Rain", rain);
                if (relief != null) overrides.SetTexture("_Relief", relief);
                roadRenderer.SetPropertyBlock(overrides);
            }
            else
            {
                target.SetFloat("_Flood", flood);
                target.SetFloat("_Wetness", wetness);
                target.SetFloat("_Rain", rain);
                if (relief != null) target.SetTexture("_Relief", relief);
            }
        }

        public float SurfaceHeight(float x, float z)
        {
            float crown = 0.03f * (1f - Mathf.Pow(x / halfWidth, 2f));
            float ruts = 0f;
            foreach (float c in RutCentres) ruts -= 0.018f * Mathf.Exp(-Mathf.Pow((x - c) / 0.32f, 2f));
            float along = (Mathf.Repeat(z, 170f) - 85f) / 9f, across = (x + 3.3f) / 1.5f;
            float pool = 0.034f * Mathf.Exp(-along * along) * (0.95f * Mathf.Exp(-across * across) + 0.5f * Mathf.Exp(-Mathf.Pow((x + 1.9f) / 2.2f, 2f)));
            float micro = relief != null ? relief.GetPixelBilinear(Mathf.Repeat(x / Tile, 1f), Mathf.Repeat(z / Tile, 1f)).r : 0.5f;
            return micro * 0.03f + crown + ruts - pool;
        }

        public float PuddleDepth(float x, float z)
        {
            if (Mathf.Abs(x) > halfWidth) return 0f;
            float level = Mathf.Lerp(-0.07f, 0.006f + 0.052f * flood, Mathf.SmoothStep(0, 1, flood / 0.15f));
            return Mathf.Max(0f, level - SurfaceHeight(x, z));
        }

        /// Emit once on sole entry, or at distance-spaced tread contacts. Units are metres and m/s.
        public void DisturbPuddle(Vector3 point, float width, float speed)
        {
            float depth = PuddleDepth(point.x, point.z);
            if (width <= 0f || speed <= 0.04f || depth <= 0.0004f) return;
            if (point.y > transform.position.y + SurfaceHeight(point.x, point.z) + depth + 0.001f) return;
            float wavelength = Mathf.Clamp(width * 1.55f, 0.045f, 0.36f);
            float k = 2f * Mathf.PI / wavelength, d = Mathf.Min(depth, 0.4f);
            float h = (float)System.Math.Tanh(k * d);
            float term = 9.81f * k + 0.000072f * k * k * k;
            float omega = Mathf.Sqrt(term * h);
            float group = ((9.81f + 0.000216f * k * k) * h + term * d * (1f - h * h)) / (2f * omega);
            float amplitude = Mathf.Min(depth * 0.36f, Mathf.Min(0.17f / k, speed * width * 0.055f));
            int slot = (first + count) % Packets;
            if (count == Packets) first = (first + 1) % Packets;
            else count++;
            events[slot] = new Vector4(point.x, point.z, clock, amplitude);
            waves[slot] = new Vector4(k, omega, group, wavelength);
            dirty = true;
        }
    }
}
