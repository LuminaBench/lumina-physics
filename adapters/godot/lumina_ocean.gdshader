// lumina-physics · ocean surface for Godot 4 (see specs/01–03).
// Spectrum-sampled Gerstner waves + physical optics: Beer–Lambert depth absorption,
// refraction, back-lit crest SSS, steepness whitecaps and a parametric breaking tsunami.
// Mesh: a dense PlaneMesh (or clipmap) following the camera. Environment SSR + sky provide
// the mirror term through the standard specular path.
shader_type spatial;
render_mode cull_disabled, depth_draw_always, specular_schlick_ggx;

const int MAX_WAVES = 64;
uniform vec4 waves[MAX_WAVES];          // xy dir, z k, w amplitude
uniform vec2 wave_phase[MAX_WAVES];     // x omega, y phase
uniform int wave_count = 0;
uniform int geometry_waves = 16;
uniform float chop = 0.9;
uniform float significant_height = 1.0;

uniform float clarity : hint_range(0.0, 1.0) = 0.85;
uniform float whitecaps : hint_range(0.0, 1.0) = 0.5;
uniform float sss_strength = 1.0;
uniform float refraction_strength = 1.0;

// Tsunami (lumina_tsunami.gd keeps these in sync with the CPU profile).
uniform float tsunami_height = 0.0;
uniform float tsunami_width = 46.0;
uniform vec2 tsunami_direction = vec2(1.0, 0.0);
uniform float tsunami_front = -100000.0;
uniform float tsunami_breaking : hint_range(0.0, 1.0) = 0.8;

uniform sampler2D depth_texture : hint_depth_texture, filter_linear, repeat_disable;
uniform sampler2D screen_texture : hint_screen_texture, filter_linear_mipmap, repeat_disable;

varying vec3 world_pos;
varying vec2 base_xz;
varying vec3 wave_info;   // crest, lip, behind

float hash12(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}

float value_noise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

// Hermite step that is well defined for reversed edges (GLSL smoothstep is not).
float sstep(float a, float b, float x) {
	float t = clamp((x - a) / (b - a), 0.0, 1.0);
	return t * t * (3.0 - 2.0 * t);
}

// Returns displacement; out: crest 0..1, lip 0..1, behind 0..1.
vec3 tsunami(vec2 p, out vec3 info) {
	info = vec3(0.0);
	if (tsunami_height < 0.01) return vec3(0.0);
	vec2 dir = tsunami_direction;
	float cross = p.y * dir.x - p.x * dir.y;
	float s = dot(p, dir) - tsunami_front + tsunami_width * (0.12 * sin(cross * 0.011 + 1.3) + 0.06 * sin(cross * 0.037 + 0.4));
	float H = tsunami_height * (1.0 + 0.12 * sin(cross * 0.017 + 0.5));
	float b = tsunami_breaking;
	float wf = tsunami_width * mix(0.6, 0.24, b);
	float wb = tsunami_width * 1.6;
	float ch = cosh(clamp(s / (s > 0.0 ? wf : wb), -20.0, 20.0));
	float crest = 1.0 / (ch * ch);
	float bore = s > 0.0 ? 0.0 : 0.3 * (1.0 - sstep(-2.5 * wb, 0.4 * wb, s)) * exp(s / (12.0 * tsunami_width));
	float tr = (s - 2.4 * wf) / (1.6 * wf);
	float eta = H * (max(crest, bore) - 0.1 * exp(-tr * tr));
	float lip = b * sstep(0.42, 1.0, crest);
	float forward = lip * H * (0.62 + 0.75 * crest);
	info = vec3(crest, lip, s > 0.0 ? 0.0 : b * exp(s / (5.0 * tsunami_width)) * (0.25 + 0.75 * sstep(0.0, -0.6 * wb, s)));
	return vec3(dir.x * forward, eta - lip * lip * H * 0.2, dir.y * forward);
}

vec3 gerstner(vec2 p, int count, out vec2 slope, out float steep) {
	vec3 d = vec3(0.0);
	slope = vec2(0.0);
	steep = 0.0;
	for (int i = 0; i < count; i++) {
		vec4 w = waves[i];
		float theta = w.z * dot(w.xy, p) - wave_phase[i].x * TIME + wave_phase[i].y;
		float s = sin(theta), c = cos(theta);
		d.xz -= w.xy * w.w * chop * s;
		d.y += w.w * c;
		slope -= w.xy * w.z * w.w * s;
		steep += w.z * w.w * chop * c;       // ≈ 1 − Jacobian: surface folding
	}
	return d;
}

void vertex() {
	vec3 wp = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	base_xz = wp.xz;
	vec2 slope; float steep;
	vec3 d = gerstner(wp.xz, min(geometry_waves, wave_count), slope, steep);
	vec3 info;
	d += tsunami(wp.xz, info);
	wave_info = info;
	wp += d;
	world_pos = wp;
	VERTEX = (inverse(MODEL_MATRIX) * vec4(wp, 1.0)).xyz;
}

void fragment() {
	vec2 slope; float steep;
	gerstner(base_xz, wave_count, slope, steep);
	// Micro wind ruffle below the shortest wave in the bank.
	float dist = length(CAMERA_POSITION_WORLD - world_pos);
	vec2 mp = base_xz * 7.0 + TIME * vec2(0.7, 0.43);
	float n0 = value_noise(mp);
	slope += vec2(value_noise(mp + vec2(0.3, 0.0)) - n0, value_noise(mp + vec2(0.0, 0.3)) - n0) / 0.3 * 0.05 * (1.0 - sstep(4.0, 45.0, dist));
	vec3 n_world = normalize(vec3(-slope.x, 1.0, -slope.y));
	NORMAL = normalize((VIEW_MATRIX * vec4(n_world, 0.0)).xyz);

	// --- Beer–Lambert through the water column ---------------------------------
	float murk = mix(5.5, 1.0, clarity);
	vec3 absorption = vec3(0.42 * (0.6 + 0.4 * murk), 0.063 * murk, 0.019 * 0.6 * murk * murk + 0.008);
	vec3 scatter = vec3(mix(0.018, 0.0035, clarity), mix(0.05, 0.021, clarity), mix(0.035, 0.05, clarity));
	vec2 uv = SCREEN_UV + NORMAL.xy * vec2(1.0, -1.0) * 0.03 * refraction_strength / (1.0 + 0.04 * -VERTEX.z);
	float raw = texture(depth_texture, uv).r;
	vec4 view = INV_PROJECTION_MATRIX * vec4(uv * 2.0 - 1.0, raw, 1.0);
	float scene_z = -view.z / view.w;
	if (scene_z < -VERTEX.z) {            // refracted sample is in front of the surface
		uv = SCREEN_UV;
		raw = texture(depth_texture, uv).r;
		view = INV_PROJECTION_MATRIX * vec4(uv * 2.0 - 1.0, raw, 1.0);
		scene_z = -view.z / view.w;
	}
	float column = max(scene_z + VERTEX.z, 0.0) * length(VERTEX) / max(-VERTEX.z, 0.1);
	vec3 transmit = exp(-absorption * column);
	vec3 background = texture(screen_texture, uv).rgb;
	vec3 body = background * transmit + scatter * 3.2 * (1.0 - transmit);

	// --- foam: folding crests, tsunami lip and churned water behind the bore -------
	float lace = value_noise(base_xz * 0.55 + TIME * 0.045) * 0.6 + value_noise(base_xz * 3.7 - TIME * 0.27) * 0.4;
	float amount = clamp(sstep(1.0 - 0.36 * whitecaps - 0.42, 1.0, steep) * 1.4
		+ sstep(0.62, 0.97, wave_info.x) * (0.25 + 1.2 * wave_info.y) + wave_info.z * 1.25, 0.0, 1.6);
	float foam = sstep(1.0 - amount * 0.72, 1.34 - amount * 0.72, lace + amount * 0.12) * sstep(0.0, 0.06, amount);
	float bubbles = value_noise(base_xz * 9.5) * 0.55 + value_noise(base_xz * 27.0) * 0.45;

	// --- outputs: unlit body via EMISSION, mirror term via the PBR specular path ---
	float fresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(NORMAL, VIEW), 0.0, 1.0), 5.0);
	// Thin crests and the overturning lip glow (back-lit transmission proxy).
	float crest_thin = sstep(0.1, 1.0, (world_pos.y) / (0.5 * significant_height + 0.15));
	vec3 sss = vec3(0.02, 0.36, 0.30) * (crest_thin * 0.35 + wave_info.y * 0.6) * sss_strength;
	ALBEDO = mix(vec3(0.0), vec3(0.9) * mix(0.78, 1.0, bubbles), foam);
	EMISSION = (body + sss) * (1.0 - fresnel) * (1.0 - foam);
	ROUGHNESS = mix(0.03, 0.7, foam);
	METALLIC = 0.0;
	SPECULAR = 0.5;
}
