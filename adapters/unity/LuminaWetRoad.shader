// lumina-physics · wet asphalt with standing-water puddles (specs/05), Unity URP.
// surfaceHeight() must stay identical to LuminaWetRoad.SurfaceHeight() on the CPU.
// Enable SSR (or planar probes) in your renderer for mirror reflections of dynamic objects.
Shader "Lumina/WetRoad"
{
    Properties
    {
        _Relief ("Relief (seamless noise, 48 m tile)", 2D) = "gray" {}
        _Flood ("Standing water", Range(0, 1)) = 0.6
        _Wetness ("Wetness", Range(0, 1)) = 1
        _Rain ("Rain ripples", Range(0, 1)) = 0.8
        _HalfWidth ("Road half width", Float) = 7.5
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" }
        Pass
        {
            Name "Forward"
            Tags { "LightMode" = "UniversalForward" }
            HLSLPROGRAM
            #pragma target 3.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_Relief); SAMPLER(sampler_Relief);
            float _Flood, _Wetness, _Rain, _HalfWidth;

            float4 _WaveEvents[24], _WaveDispersion[24];
            float _WaveFirst, _WaveCount;
            float _WaveClock;

            struct Varyings { float4 positionCS : SV_POSITION; float3 positionWS : TEXCOORD0; };

            float sstep(float a, float b, float x) { float t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); }
            float hash12(float2 p) { float3 p3 = frac(float3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return frac((p3.x + p3.y) * p3.z); }
            float2 hash22(float2 p) { float3 p3 = frac(float3(p.xyx) * float3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return frac((p3.xx + p3.yz) * p3.zy); }
            float valueNoise(float2 p) { float2 i = floor(p), f = frac(p); float2 u = f * f * (3 - 2 * f); return lerp(lerp(hash12(i), hash12(i + float2(1, 0)), u.x), lerp(hash12(i + float2(0, 1)), hash12(i + float2(1, 1)), u.x), u.y); }

            float surfaceHeight(float2 xz)
            {
                float acrossRoad = xz.x / max(0.01, _HalfWidth);
                float crown = 0.03 * (1 - acrossRoad * acrossRoad);
                float ruts = 0;
                const float centres[4] = { -2.75, -1.05, 1.05, 2.75 };
                for (int i = 0; i < 4; i++) { float d = (xz.x - centres[i]) / 0.32; ruts -= 0.018 * exp(-d * d); }
                float along = (fmod(fmod(xz.y, 170) + 170, 170) - 85) / 9;
                float across = (xz.x + 3.3) / 1.5;
                float shoulder = (xz.x + 1.9) / 2.2;
                float pool = 0.034 * exp(-along * along) * (0.95 * exp(-across * across) + 0.5 * exp(-shoulder * shoulder));
                return SAMPLE_TEXTURE2D_LOD(_Relief, sampler_Relief, xz / 48, 0).r * 0.03 + crown + ruts - pool;
            }

            float2 rainRipples(float2 p)
            {
                float2 slope = 0;
                const float scales[2] = { 2.6, 1.45 };
                const float rates[2] = { 1.25, 0.9 };
                for (int l = 0; l < 2; l++)
                {
                    float2 q = p * scales[l], cell = floor(q), local = frac(q);
                    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++)
                    {
                        float2 o = float2(i, j), id = cell + o + l * 31.7;
                        float phase = frac(_Time.y * rates[l] + hash12(id + 17.13));
                        float2 delta = local - (o + hash22(id));
                        float d = length(delta) + 1e-4, ring = d - phase * 1.05;
                        slope += delta / d * sin(ring * 34) * exp(-ring * ring * 70) * pow(1 - phase, 2);
                    }
                }
                return slope;
            }

            float2 contact_slope(float2 xz) {
                float2 slope = float2(0.0, 0.0);
                for (int packet = 0; packet < (int)_WaveCount; packet++) {
                    int i = ((int)_WaveFirst + packet) % 24;
                    float4 event_data = _WaveEvents[i], wave = _WaveDispersion[i];
                    float age = _WaveClock - event_data.z;
                    float2 delta = xz - event_data.xy;
                    float r = length(delta), width = wave.w * 0.7 + age * 0.045;
                    float front = r - wave.z * age;
                    if (abs(front) > 2.6 * width) continue;
                    float phase = wave.x * r - wave.y * age;
                    float radius = wave.w * 0.45, norm_front = front / width;
                    float falloff = exp(-norm_front * norm_front - age * 1.8) * sqrt(radius / (r + radius));
                    float grad = wave.x * cos(phase) - sin(phase) * (2.0 * front / (width * width) + 0.5 / (r + radius));
                    slope += delta / max(r, 0.0001) * grad * event_data.w * falloff
                        * smoothstep(0.0, 0.025, age) * (1.0 - smoothstep(1.5, 1.8, age));
                }
                return slope;
            }

            Varyings vert(float4 positionOS : POSITION)
            {
                Varyings o;
                o.positionWS = TransformObjectToWorld(positionOS.xyz);
                o.positionCS = TransformWorldToHClip(o.positionWS);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                float2 xz = i.positionWS.xz;
                float waterLine = lerp(-0.07, 0.006 + 0.052 * _Flood, smoothstep(0, 0.15, _Flood));
                float depth = abs(xz.x) <= _HalfWidth ? max(waterLine - surfaceHeight(xz), 0) : 0;
                float film = sstep(0, 0.0036, depth);
                float2 slope = 0;
                if (film > 0)
                {
                    if (_Rain > 0) slope += rainRipples(xz) * _Rain * 0.062;
                    float viewDistance = distance(GetCameraPositionWS(), i.positionWS);
                    if (_WaveCount > 0 && viewDistance < 45)
                        slope += contact_slope(xz) * (1 - smoothstep(20, 45, viewDistance));
                }
                slope *= film;
                float3 normalWS = normalize(float3(-slope.x, 1, -slope.y));
                float3 viewDir = normalize(GetWorldSpaceViewDir(i.positionWS));
                float3 ray = refract(-viewDir, normalWS, 1.0 / 1.333);
                float2 bed = xz + ray.xz * depth * film / max(-ray.y, 0.15);
                float stones = valueNoise(bed * 170) * 0.6 + valueNoise(bed * 61) * 0.4;
                float3 albedo = lerp(float3(0.028, 0.029, 0.031), float3(0.105, 0.102, 0.098), stones) * lerp(0.72, 1.12, valueNoise(bed * 0.16 + 4.2));
                float edgeLine = sstep(0.085, 0.06, abs(abs(bed.x) - 6.4));
                float dash = sstep(0.085, 0.06, abs(bed.x)) * sstep(0.34, 0.36, frac(bed.y / 9));
                albedo = lerp(albedo, float3(0.62, 0.61, 0.56), max(edgeLine, dash) * 0.8) * lerp(1, 0.4, _Wetness);

                SurfaceData s = (SurfaceData)0;
                s.albedo = albedo;
                s.smoothness = 1 - lerp(lerp(0.86, 0.46, _Wetness), 0.02, film);
                s.specular = lerp(0.04, 0.02, film);
                s.occlusion = 1;
                s.alpha = 1;
                InputData inputData = (InputData)0;
                inputData.positionWS = i.positionWS;
                inputData.normalWS = normalWS;
                inputData.viewDirectionWS = viewDir;
                inputData.shadowCoord = TransformWorldToShadowCoord(i.positionWS);
                inputData.bakedGI = SampleSH(inputData.normalWS);
                inputData.normalizedScreenSpaceUV = GetNormalizedScreenSpaceUV(i.positionCS);
                return UniversalFragmentPBR(inputData, s);
            }
            ENDHLSL
        }
    }
}
