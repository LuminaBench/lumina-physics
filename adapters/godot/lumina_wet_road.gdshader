// lumina-physics · wet asphalt with standing-water puddles (specs/05).
// The height function here must stay identical to LuminaWetRoad.puddle_depth() so tires
// feel exactly the puddles that are drawn. Environment SSR supplies mirror reflections.
shader_type spatial;

uniform sampler2D relief : hint_default_white, filter_linear_mipmap, repeat_enable;   // seamless noise, 48 m tile
uniform bool use_relief = true;
uniform float flood : hint_range(0.0, 1.0) = 0.6;
uniform float wetness : hint_range(0.0, 1.0) = 1.0;
uniform float rain : hint_range(0.0, 1.0) = 0.8;
uniform float half_width = 7.5;

uniform vec4 wave_events[24];
uniform vec4 wave_dispersion[24];
uniform int wave_first = 0;
uniform int wave_count = 0;
uniform float wave_clock = 0.0;
varying vec3 world_pos;

float sstep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float value_noise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f); return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }

float surface_height(vec2 xz) {
	float across_road = xz.x / max(0.01, half_width);
	float crown = 0.03 * (1.0 - across_road * across_road);
	float ruts = 0.0;
	float centres[4] = float[](-2.75, -1.05, 1.05, 2.75);
	for (int i = 0; i < 4; i++) { float d = (xz.x - centres[i]) / 0.32; ruts -= 0.018 * exp(-d * d); }
	float along = (mod(mod(xz.y, 170.0) + 170.0, 170.0) - 85.0) / 9.0;
	float across = (xz.x + 3.3) / 1.5;
	float shoulder = (xz.x + 1.9) / 2.2;
	float pool = 0.034 * exp(-along * along) * (0.95 * exp(-across * across) + 0.5 * exp(-shoulder * shoulder));
	return (use_relief ? textureLod(relief, xz / 48.0, 0.0).r : 0.5) * 0.03 + crown + ruts - pool;
}

// Expanding raindrop rings → surface slope.
vec2 rain_ripples(vec2 p) {
	vec2 slope = vec2(0.0);
	float scales[2] = float[](2.6, 1.45);
	float rates[2] = float[](1.25, 0.9);
	for (int l = 0; l < 2; l++) {
		vec2 q = p * scales[l];
		vec2 cell = floor(q), local = fract(q);
		for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
			vec2 o = vec2(float(i), float(j));
			vec2 id = cell + o + float(l) * 31.7;
			float phase = fract(TIME * rates[l] + hash12(id + 17.13));
			vec2 delta = local - (o + hash22(id));
			float d = length(delta) + 1e-4;
			float ring = d - phase * 1.05;
			slope += delta / d * sin(ring * 34.0) * exp(-ring * ring * 70.0) * pow(1.0 - phase, 2.0);
		}
	}
	return slope;
}

vec2 contact_slope(vec2 xz) {
    vec2 slope = vec2(0.0, 0.0);
    for (int packet = 0; packet < wave_count; packet++) {
        int i = (wave_first + packet) % 24;
        vec4 event_data = wave_events[i], wave = wave_dispersion[i];
        float age = wave_clock - event_data.z;
        vec2 delta = xz - event_data.xy;
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

void vertex() { world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz; }

void fragment() {
	vec2 xz = world_pos.xz;
	float water_line = mix(-0.07, 0.006 + 0.052 * flood, smoothstep(0.0, 0.15, flood));
	float depth = abs(xz.x) <= half_width ? max(water_line - surface_height(xz), 0.0) : 0.0;
	float film = sstep(0.0, 0.0036, depth);
	vec2 slope = vec2(0.0);
	if (film > 0.0) {
		if (rain > 0.0) slope += rain_ripples(xz) * rain * 0.062;
		float view_dist = distance(CAMERA_POSITION_WORLD, world_pos);
		if (wave_count > 0 && view_dist < 45.0) slope += contact_slope(xz) * (1.0 - smoothstep(20.0, 45.0, view_dist));
	}
	slope *= film;
	vec3 n_world = normalize(vec3(-slope.x, 1.0, -slope.y));
	vec3 incident = normalize((INV_VIEW_MATRIX * vec4(-VIEW, 0.0)).xyz);
	vec3 ray = refract(incident, n_world, 1.0 / 1.333);
	vec2 bed = xz + ray.xz * depth * film / max(-ray.y, 0.15);
	float stones = value_noise(bed * 170.0) * 0.6 + value_noise(bed * 61.0) * 0.4;
	vec3 albedo = mix(vec3(0.028, 0.029, 0.031), vec3(0.105, 0.102, 0.098), stones) * mix(0.72, 1.12, value_noise(bed * 0.16 + 4.2));
	float edge_line = sstep(0.085, 0.06, abs(abs(bed.x) - 6.4));
	float dash = sstep(0.085, 0.06, abs(bed.x)) * sstep(0.34, 0.36, fract(bed.y / 9.0));
	albedo = mix(albedo, vec3(0.62, 0.61, 0.56), max(edge_line, dash) * 0.8);
	ALBEDO = albedo * mix(1.0, 0.4, wetness);
	ROUGHNESS = mix(mix(0.86, 0.46, wetness), 0.02, film);
	METALLIC = 0.0;
	SPECULAR = mix(0.5, 0.35, film);
	NORMAL = normalize((VIEW_MATRIX * vec4(n_world, 0.0)).xyz);
}
