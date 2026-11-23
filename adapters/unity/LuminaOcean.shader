// lumina-physics · ocean surface for Unity URP (specs/01–03).
// Spectrum-sampled Gerstner waves + Beer–Lambert depth absorption, refraction, Schlick
// Fresnel against reflection probes, GGX sun glitter, crest SSS, whitecaps, tsunami lip.
// Requires "Depth Texture" and "Opaque Texture" enabled on the URP asset.
Shader "Lumina/Ocean"
{
    Properties
    {
        _Clarity ("Water clarity", Range(0, 1)) = 0.85
        _Whitecaps ("Whitecaps", Range(0, 1)) = 0.5
        _SssStrength ("Subsurface strength", Float) = 1
        _Refraction ("Refraction strength", Float) = 1
        _TsunamiHeight ("Tsunami height", Float) = 0
        _TsunamiWidth ("Tsunami width", Float) = 46
        _TsunamiDirection ("Tsunami direction (xz)", Vector) = (1, 0, 0, 0)
        _TsunamiFront ("Tsunami front", Float) = -100000
        _TsunamiBreaking ("Tsunami breaking", Range(0, 1)) = 0.8
    }
    SubShader
    {
        Tags { "RenderType" = "Transparent" "Queue" = "Transparent-10" "RenderPipeline" = "UniversalPipeline" }
        Pass
        {
            Name "Forward"
            Tags { "LightMode" = "UniversalForward" }
            ZWrite On
            Cull Off
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareOpaqueTexture.hlsl"

            #define MAX_WAVES 64
            float4 _Waves[MAX_WAVES];      // xy dir, z k, w amplitude
            float4 _WavePhase[MAX_WAVES];  // x omega, y phase
            int _WaveCount, _GeometryWaves;
            float _Chop, _SignificantHeight, _Clarity, _Whitecaps, _SssStrength, _Refraction;
            float _TsunamiHeight, _TsunamiWidth, _TsunamiFront, _TsunamiBreaking;
            float4 _TsunamiDirection;

            struct Varyings { float4 positionCS : SV_POSITION; float3 positionWS : TEXCOORD0; float2 baseXZ : TEXCOORD1; float3 wave : TEXCOORD2; float4 screenPos : TEXCOORD3; };

            float hash12(float2 p) { float3 p3 = frac(float3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return frac((p3.x + p3.y) * p3.z); }
            float valueNoise(float2 p) { float2 i = floor(p), f = frac(p); float2 u = f * f * (3 - 2 * f); return lerp(lerp(hash12(i), hash12(i + float2(1, 0)), u.x), lerp(hash12(i + float2(0, 1)), hash12(i + float2(1, 1)), u.x), u.y); }
            // Hermite step that is well defined for reversed edges.
            float sstep(float a, float b, float x) { float t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); }

            float3 Tsunami(float2 p, out float3 info)
            {
                info = 0;
                if (_TsunamiHeight < 0.01) return 0;
                float2 dir = _TsunamiDirection.xy;
                float cr = p.y * dir.x - p.x * dir.y;
                float s = dot(p, dir) - _TsunamiFront + _TsunamiWidth * (0.12 * sin(cr * 0.011 + 1.3) + 0.06 * sin(cr * 0.037 + 0.4));
                float H = _TsunamiHeight * (1 + 0.12 * sin(cr * 0.017 + 0.5));
                float b = _TsunamiBreaking, wf = _TsunamiWidth * lerp(0.6, 0.24, b), wb = _TsunamiWidth * 1.6;
                float ch = cosh(clamp(s / (s > 0 ? wf : wb), -20, 20));
                float crest = 1 / (ch * ch);
                float bore = s > 0 ? 0 : 0.3 * (1 - sstep(-2.5 * wb, 0.4 * wb, s)) * exp(s / (12 * _TsunamiWidth));
                float tr = (s - 2.4 * wf) / (1.6 * wf);
                float eta = H * (max(crest, bore) - 0.1 * exp(-tr * tr));
                float lip = b * sstep(0.42, 1, crest);
                float fwd = lip * H * (0.62 + 0.75 * crest);
                info = float3(crest, lip, s > 0 ? 0 : b * exp(s / (5 * _TsunamiWidth)) * (0.25 + 0.75 * sstep(0, -0.6 * wb, s)));
                return float3(dir.x * fwd, eta - lip * lip * H * 0.2, dir.y * fwd);
            }

            float3 Gerstner(float2 p, int count, out float2 slope, out float steep)
            {
                float3 d = 0; slope = 0; steep = 0;
                for (int i = 0; i < count; i++)
                {
                    float4 w = _Waves[i];
                    float theta = w.z * dot(w.xy, p) - _WavePhase[i].x * _Time.y + _WavePhase[i].y;
                    float s = sin(theta), c = cos(theta);
                    d.xz -= w.xy * w.w * _Chop * s;
                    d.y += w.w * c;
                    slope -= w.xy * w.z * w.w * s;
                    steep += w.z * w.w * _Chop * c;
                }
                return d;
            }

            Varyings vert(float4 positionOS : POSITION)
            {
                Varyings o;
                float3 wp = TransformObjectToWorld(positionOS.xyz);
                o.baseXZ = wp.xz;
                float2 slope; float steep; float3 info;
                wp += Gerstner(wp.xz, min(_GeometryWaves, _WaveCount), slope, steep) + Tsunami(wp.xz, info);
                o.wave = info;
                o.positionWS = wp;
                o.positionCS = TransformWorldToHClip(wp);
                o.screenPos = ComputeScreenPos(o.positionCS);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                float2 slope; float steep;
                Gerstner(i.baseXZ, _WaveCount, slope, steep);
                float3 V = normalize(GetWorldSpaceViewDir(i.positionWS));
                float dist = distance(_WorldSpaceCameraPos, i.positionWS);
                float2 mp = i.baseXZ * 7 + _Time.y * float2(0.7, 0.43);
                float n0 = valueNoise(mp);
                slope += float2(valueNoise(mp + float2(0.3, 0)) - n0, valueNoise(mp + float2(0, 0.3)) - n0) / 0.3 * 0.05 * (1 - sstep(4, 45, dist));
                float3 N = normalize(float3(-slope.x, 1, -slope.y));
                N = normalize(N + V * max(0.04 - dot(N, V), 0));
                float NdotV = max(dot(N, V), 0.02);

                Light sun = GetMainLight();
                float3 L = sun.direction;
                float fresnel = 0.02 + 0.98 * pow(1 - NdotV, 5);
                float3 R = reflect(-V, N); R.y = abs(R.y);
                float3 reflection = GlossyEnvironmentReflection(R, i.positionWS, 0.04, 1.0);
                float3 H = normalize(L + V);
                float a2 = 0.0009, nh = saturate(dot(N, H)), dn = nh * nh * (a2 - 1) + 1;
                float nl = saturate(dot(N, L));
                float3 glint = sun.color * min(a2 / (PI * dn * dn) * (0.02 + 0.98 * pow(1 - saturate(dot(V, H)), 5)) * nl / (4 * nl * NdotV + 0.02), 90);

                // Refraction + Beer–Lambert.
                float2 uv = i.screenPos.xy / i.screenPos.w;
                float surfaceZ = i.screenPos.w;
                float3 viewN = TransformWorldToViewDir(N);
                float2 uvR = saturate(uv + viewN.xy * 0.03 * _Refraction / (1 + 0.04 * surfaceZ));
                float sceneZ = LinearEyeDepth(SampleSceneDepth(uvR), _ZBufferParams);
                if (sceneZ < surfaceZ) { uvR = uv; sceneZ = LinearEyeDepth(SampleSceneDepth(uv), _ZBufferParams); }
                float column = max(sceneZ - surfaceZ, 0) * dist / max(surfaceZ, 0.1);
                float murk = lerp(5.5, 1, _Clarity);
                float3 absorption = float3(0.42 * (0.6 + 0.4 * murk), 0.063 * murk, 0.019 * 0.6 * murk * murk + 0.008);
                float3 scatter = float3(lerp(0.018, 0.0035, _Clarity), lerp(0.05, 0.021, _Clarity), lerp(0.035, 0.05, _Clarity));
                float3 transmit = exp(-absorption * column);
                float3 ambient = SampleSH(float3(0, 1, 0));
                float3 downwelling = sun.color * max(L.y, 0) / PI + ambient;
                float3 body = SampleSceneColor(uvR) * transmit + scatter * downwelling * (1 - transmit);

                // Back-lit crests + the overturning tsunami lip.
                float towardSun = pow(saturate(dot(V, -normalize(float3(L.x, -0.15, L.z)))), 3);
                float crestThin = sstep(0.1, 1, i.positionWS.y / (0.5 * _SignificantHeight + 0.15)) * (0.3 + 0.7 * (1 - NdotV));
                body += float3(0.02, 0.36, 0.30) * sun.color / PI * (towardSun * crestThin * 0.55 + i.wave.y * (0.2 + 0.8 * towardSun) * 0.45) * _SssStrength;

                float3 color = lerp(body, reflection, fresnel) + glint;

                // Foam: folding crests, lip, churned bore; lacy breakup + bubble texture.
                float lace = valueNoise(i.baseXZ * 0.55 + _Time.y * 0.045) * 0.6 + valueNoise(i.baseXZ * 3.7 - _Time.y * 0.27) * 0.4;
                float amount = saturate(sstep(0.58 - 0.36 * _Whitecaps, 1, steep) * 1.4) + sstep(0.62, 0.97, i.wave.x) * (0.25 + 1.2 * i.wave.y) + i.wave.z * 1.25;
                amount = clamp(amount, 0, 1.6);
                float foam = sstep(1 - amount * 0.72, 1.34 - amount * 0.72, lace + amount * 0.12) * sstep(0, 0.06, amount);
                float bubbles = valueNoise(i.baseXZ * 9.5) * 0.55 + valueNoise(i.baseXZ * 27) * 0.45;
                float thickness = sstep(0.35, 1.25, amount * (0.6 + 0.8 * lace));
                float3 foamLit = lerp(float3(0.5, 0.56, 0.56), 0.93, thickness) * lerp(0.78, 1, bubbles) * (sun.color * saturate(dot(normalize(lerp(float3(0, 1, 0), N, 0.6)), L)) / PI + ambient);
                color = lerp(color, foamLit, foam * lerp(0.62, 0.96, thickness));
                return half4(color, 1);
            }
            ENDHLSL
        }
    }
}
