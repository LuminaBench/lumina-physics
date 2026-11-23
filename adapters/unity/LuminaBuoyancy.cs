// lumina-physics · multi-point buoyancy + hydrodynamic drag (specs/04).
using UnityEngine;

namespace Lumina.Physics
{
    [RequireComponent(typeof(Rigidbody))]
    public class LuminaBuoyancy : MonoBehaviour
    {
        const float WaterDensity = 1025f;

        public LuminaWaveSpectrum spectrum;
        public LuminaTsunami tsunami;
        [Tooltip("Sample points in local space (e.g. four along each float / hull side).")]
        public Vector3[] points = { new Vector3(-1, 0, -2), new Vector3(1, 0, -2), new Vector3(-1, 0, 2), new Vector3(1, 0, 2) };
        [Tooltip("Total displaced volume when fully submerged (m³).")]
        public float volume = 6.4f;
        public float draft = 0.75f;
        public float linearDrag = 60f;
        public float quadraticDrag = 18f;
        public float heaveDamping = 2600f;
        public float keel = 6f;

        /// <summary>Mean submersion of all points (0..1).</summary>
        public float Submersion { get; private set; }
        Rigidbody body;

        void Awake() => body = GetComponent<Rigidbody>();

        public float WaterHeight(float x, float z)
        {
            float h = spectrum != null ? spectrum.HeightAt(x, z, Time.time) : 0f;
            if (tsunami != null) h += tsunami.HeightAt(x, z);
            return h;
        }

        void FixedUpdate()
        {
            if (points.Length == 0) return;
            float perPoint = volume / points.Length, total = 0f;
            Vector3 right = transform.right;
            foreach (Vector3 local in points)
            {
                Vector3 p = transform.TransformPoint(local);
                float depth = WaterHeight(p.x, p.z) - p.y;
                float sub = Mathf.Clamp01(depth / draft + 0.5f);
                total += sub;
                if (sub <= 0f) continue;
                Vector3 flow = tsunami != null ? tsunami.FlowAt(p.x, p.z) : Vector3.zero;
                Vector3 v = body.GetPointVelocity(p) - flow;
                float k = (linearDrag + quadraticDrag * v.magnitude) * sub;
                Vector3 force = new Vector3(-v.x * k, WaterDensity * 9.81f * perPoint * sub, -v.z * k);
                force.y -= v.y * (heaveDamping * sub + quadraticDrag * Mathf.Abs(v.y));
                force -= right * (Vector3.Dot(v, right) * k * keel);    // keel: resist sideways slip
                body.AddForceAtPosition(force, p, ForceMode.Force);
            }
            Submersion = total / points.Length;
        }
    }
}
