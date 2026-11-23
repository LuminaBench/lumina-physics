// lumina-physics · JONSWAP wave bank (specs/01-ocean-spectrum-fft.md).
// Samples the directional spectrum into N Gerstner waves that drive both the ocean shader
// and CPU buoyancy. For full FFT parity, port the passes in specs/01 to a ComputeShader.
using UnityEngine;

namespace Lumina.Physics
{
    [ExecuteAlways]
    public class LuminaWaveSpectrum : MonoBehaviour
    {
        public const int MaxWaves = 64;
        const float Gravity = 9.81f;

        [Header("Sea state")]
        public float windSpeed = 8f;                 // m/s at 10 m
        public float windDirection = 0.4f;           // radians, travel direction (0 = +X)
        public float fetch = 60000f;                 // m
        public float swellHeight = 0.6f;             // significant height, m
        public float swellDirection = 0.8f;
        public float swellPeriod = 9f;
        [Range(0f, 1.4f)] public float chop = 0.9f;
        [Range(8, MaxWaves)] public int waveCount = 48;
        public int seed = 7;
        public Material oceanMaterial;

        public float SignificantHeight { get; private set; }
        readonly Vector4[] waves = new Vector4[MaxWaves];   // xy dir, z k, w amplitude
        readonly Vector4[] phases = new Vector4[MaxWaves];  // x omega, y phase
        int count;

        static readonly int WavesId = Shader.PropertyToID("_Waves");
        static readonly int PhasesId = Shader.PropertyToID("_WavePhase");
        static readonly int CountId = Shader.PropertyToID("_WaveCount");
        static readonly int GeoCountId = Shader.PropertyToID("_GeometryWaves");
        static readonly int ChopId = Shader.PropertyToID("_Chop");
        static readonly int HsId = Shader.PropertyToID("_SignificantHeight");

        void OnEnable() => Rebuild();
        void OnValidate() => Rebuild();

        float Jonswap(float omega, float omegaP)
        {
            float u = Mathf.Max(windSpeed, 0.2f);
            float alpha = 0.076f * Mathf.Pow(u * u / (fetch * Gravity), 0.22f);
            float sigma = omega <= omegaP ? 0.07f : 0.09f;
            float r = Mathf.Exp(-Mathf.Pow(omega - omegaP, 2f) / (2f * sigma * sigma * omegaP * omegaP));
            return alpha * Gravity * Gravity / Mathf.Pow(omega, 5f) * Mathf.Exp(-1.25f * Mathf.Pow(omegaP / omega, 4f)) * Mathf.Pow(3.3f, r);
        }

        public void Rebuild()
        {
            var rng = new System.Random(seed);
            float Uniform() => (float)rng.NextDouble();
            float Gaussian() => Mathf.Sqrt(-2f * Mathf.Log(Mathf.Max(Uniform(), 1e-6f))) * Mathf.Cos(2f * Mathf.PI * Uniform());
            float u = Mathf.Max(windSpeed, 0.2f);
            float omegaP = 22f * Mathf.Pow(Gravity * Gravity / (u * fetch), 1f / 3f);
            int swellWaves = swellHeight > 0.01f ? 4 : 0;
            int windWaves = Mathf.Clamp(waveCount, 8, MaxWaves) - swellWaves;
            float lo = omegaP * 0.6f, hi = Mathf.Max(omegaP * 9f, 7f), m0 = 0f;
            count = 0;
            for (int i = 0; i < windWaves; i++)
            {
                float f0 = lo * Mathf.Pow(hi / lo, (float)i / windWaves), f1 = lo * Mathf.Pow(hi / lo, (float)(i + 1) / windWaves);
                float omega = Mathf.Sqrt(f0 * f1);
                float amplitude = Mathf.Sqrt(2f * Jonswap(omega, omegaP) * (f1 - f0));
                float ratio = omega / omegaP;
                float s = Mathf.Max(1.2f, 14f * (ratio <= 1f ? Mathf.Pow(ratio, 5f) : Mathf.Pow(ratio, -2.5f)));
                float theta = windDirection + Gaussian() * Mathf.Sqrt(2f / (s + 1f));
                waves[count] = new Vector4(Mathf.Cos(theta), Mathf.Sin(theta), omega * omega / Gravity, amplitude);
                phases[count++] = new Vector4(omega, Uniform() * 2f * Mathf.PI, 0, 0);
                m0 += 0.5f * amplitude * amplitude;
            }
            for (int i = 0; i < swellWaves; i++)
            {
                float omega = 2f * Mathf.PI / swellPeriod * (1f + (i - 1.5f) * 0.045f);
                float amplitude = swellHeight / 4f * Mathf.Sqrt(2f / swellWaves);
                float theta = swellDirection + (i - 1.5f) * 0.05f;
                waves[count] = new Vector4(Mathf.Cos(theta), Mathf.Sin(theta), omega * omega / Gravity, amplitude);
                phases[count++] = new Vector4(omega, Uniform() * 2f * Mathf.PI, 0, 0);
                m0 += 0.5f * amplitude * amplitude;
            }
            SignificantHeight = 4f * Mathf.Sqrt(m0);
            Apply();
        }

        public void Apply()
        {
            if (oceanMaterial == null) return;
            oceanMaterial.SetVectorArray(WavesId, waves);
            oceanMaterial.SetVectorArray(PhasesId, phases);
            oceanMaterial.SetInt(CountId, count);
            oceanMaterial.SetInt(GeoCountId, Mathf.Min(LuminaQuality.Preset.geometryWaves, count));
            oceanMaterial.SetFloat(ChopId, chop);
            oceanMaterial.SetFloat(HsId, SignificantHeight);
        }

        Vector3 Displacement(float x, float z, float t)
        {
            Vector3 d = Vector3.zero;
            for (int i = 0; i < count; i++)
            {
                Vector4 w = waves[i];
                float theta = w.z * (w.x * x + w.y * z) - phases[i].x * t + phases[i].y;
                float s = Mathf.Sin(theta);
                d.x -= w.x * w.w * chop * s;
                d.z -= w.y * w.w * chop * s;
                d.y += w.w * Mathf.Cos(theta);
            }
            return d;
        }

        /// <summary>Water surface height at a world position (inverts the choppy displacement).</summary>
        public float HeightAt(float x, float z, float t)
        {
            float px = x, pz = z;
            for (int i = 0; i < 3; i++) { Vector3 d = Displacement(px, pz, t); px = x - d.x; pz = z - d.z; }
            return transform.position.y + Displacement(px, pz, t).y;
        }
    }
}
