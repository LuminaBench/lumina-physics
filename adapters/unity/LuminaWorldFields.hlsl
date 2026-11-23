#ifndef LUMINA_WORLD_FIELDS_INCLUDED
#define LUMINA_WORLD_FIELDS_INCLUDED
int _LuminaFieldCount;
float _LuminaRainFilm;
float4 _LuminaFieldStart[16];
float4 _LuminaFieldAxis[16];
float4 _LuminaFieldScalar[16];

float4 LuminaFieldSample(float3 positionWS)
{
    float4 result = float4(0, 0, _LuminaRainFilm, 0);
    for (int i = 0; i < _LuminaFieldCount; ++i)
    {
        float3 ap = positionWS - _LuminaFieldStart[i].xyz;
        float4 axis = _LuminaFieldAxis[i];
        float3 d = ap - axis.xyz * saturate(dot(ap, axis.xyz) * axis.w);
        float weight = saturate(1 - dot(d,d) * _LuminaFieldStart[i].w);
        result += _LuminaFieldScalar[i] * weight * weight;
    }
    result.zw = saturate(result.zw);
    return result;
}
#endif
