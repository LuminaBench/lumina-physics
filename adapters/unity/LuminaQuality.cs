// lumina-physics · 5-tier quality presets for Unity (URP 14+ / Unity 2022.3+).
using System;
using UnityEngine;
using UnityEngine.Rendering.Universal;

namespace Lumina.Physics
{
    public enum LuminaTier { Low, Medium, High, XHigh, Ultra }

    [Serializable]
    public struct LuminaPreset
    {
        public float renderScale;      // < 1 → temporal upscaling (STP / TAA-U)
        public int waveCount;          // Gerstner bank size
        public int geometryWaves;      // waves evaluated in the vertex stage
        public int particleBudget;
        public bool screenSpaceReflections;
        public int shadowResolution;
        public int maxDebris;
    }

    public class LuminaQuality : MonoBehaviour
    {
        public static readonly LuminaPreset[] Presets =
        {
            new LuminaPreset { renderScale = 0.67f, waveCount = 16, geometryWaves = 8,  particleBudget = 2048,  screenSpaceReflections = false, shadowResolution = 1024, maxDebris = 24 },
            new LuminaPreset { renderScale = 0.77f, waveCount = 32, geometryWaves = 12, particleBudget = 8192,  screenSpaceReflections = false, shadowResolution = 2048, maxDebris = 48 },
            new LuminaPreset { renderScale = 1f,    waveCount = 48, geometryWaves = 16, particleBudget = 20480, screenSpaceReflections = true,  shadowResolution = 2048, maxDebris = 96 },
            new LuminaPreset { renderScale = 1f,    waveCount = 56, geometryWaves = 20, particleBudget = 49152, screenSpaceReflections = true,  shadowResolution = 4096, maxDebris = 160 },
            new LuminaPreset { renderScale = 1f,    waveCount = 64, geometryWaves = 24, particleBudget = 90112, screenSpaceReflections = true,  shadowResolution = 4096, maxDebris = 256 },
        };

        public static LuminaTier Tier { get; private set; } = LuminaTier.High;
        public static LuminaPreset Preset => Presets[(int)Tier];
        public static event Action<LuminaTier, LuminaPreset> TierChanged;

        [SerializeField] private bool detectOnStart = true;

        private void Start() { if (detectOnStart) Apply(Detect()); }

        /// <summary>Heuristic starting tier from the graphics device.</summary>
        public static LuminaTier Detect()
        {
            if (Application.isMobilePlatform) return LuminaTier.Low;
            int vram = SystemInfo.graphicsMemorySize;
            if (!SystemInfo.supportsComputeShaders || vram < 2000) return LuminaTier.Low;
            if (vram < 4000) return LuminaTier.Medium;
            if (vram < 8000) return LuminaTier.High;
            return vram < 12000 ? LuminaTier.XHigh : LuminaTier.Ultra;
        }

        public static void Apply(LuminaTier tier)
        {
            Tier = tier;
            var preset = Preset;
            if (UniversalRenderPipeline.asset is UniversalRenderPipelineAsset urp)
            {
                urp.renderScale = preset.renderScale;
                urp.msaaSampleCount = 1;           // temporal AA owns edge quality
                urp.supportsHDR = true;
            }
            foreach (var cam in Camera.allCameras)
            {
                var data = cam.GetUniversalAdditionalCameraData();
                if (data != null) data.antialiasing = AntialiasingMode.TemporalAntiAliasing;
            }
            QualitySettings.shadowResolution = preset.shadowResolution >= 4096 ? ShadowResolution.VeryHigh
                : preset.shadowResolution >= 2048 ? ShadowResolution.High : ShadowResolution.Medium;
            TierChanged?.Invoke(tier, preset);
        }
    }
}
