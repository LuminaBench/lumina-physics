// lumina-physics · aquaplaning for WheelCollider vehicles (specs/05).
using UnityEngine;

namespace Lumina.Physics
{
    [RequireComponent(typeof(Rigidbody))]
    public class LuminaAquaplaning : MonoBehaviour
    {
        public LuminaWetRoad road;
        public WheelCollider[] wheels;
        public float tirePressureKPa = 220f;
        public float treadDepth = 0.0028f;
        [Tooltip("Friction stiffness on dry / saturated asphalt with full contact.")]
        public float dryGrip = 1.6f, wetGrip = 1.1f;

        /// <summary>Mean hydroplaning factor of all wheels (0..1).</summary>
        public float Hydroplaning { get; private set; }
        public float[] WheelDepth { get; private set; }
        Rigidbody body;

        /// <summary>NASA dynamic hydroplaning onset speed in m/s.</summary>
        public static float HydroplaningSpeed(float pressureKPa) => 6.35f * Mathf.Sqrt(pressureKPa) / 3.6f;

        void Awake() { body = GetComponent<Rigidbody>(); WheelDepth = new float[wheels.Length]; }

        void FixedUpdate()
        {
            if (road == null) return;
            float vp = HydroplaningSpeed(tirePressureKPa);
            Vector3 velocity = body.linearVelocity;
            float speed = velocity.magnitude, sum = 0f;
            for (int i = 0; i < wheels.Length; i++)
            {
                WheelCollider wheel = wheels[i];
                bool grounded = wheel.GetGroundHit(out WheelHit hit);
                float depth = grounded ? road.PuddleDepth(hit.point.x, hit.point.z) : 0f;
                WheelDepth[i] = depth;
                float depthFactor = Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(treadDepth, treadDepth + 0.0095f, depth));
                float hydro = depthFactor * Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(0.74f * vp, 1.08f * vp, speed));
                float viscous = 0.22f * depthFactor * Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(0.3f * vp, 0.74f * vp, speed));
                float grip = Mathf.Lerp(dryGrip, wetGrip, road.wetness) * Mathf.Max(0.05f, 1f - 0.95f * hydro - viscous);
                WheelFrictionCurve forward = wheel.forwardFriction; forward.stiffness = grip; wheel.forwardFriction = forward;
                WheelFrictionCurve side = wheel.sidewaysFriction; side.stiffness = grip * Mathf.Lerp(1f, 0.1f, hydro); wheel.sidewaysFriction = side;
                sum += hydro;
                if (grounded && depth > 0.0005f && speed > 1f)
                {
                    // Momentum lost to displaced water; unequal depth left/right yaws the car.
                    float drag = 0.5f * 1000f * 0.85f * (0.22f * Mathf.Min(depth, 0.05f)) * speed * speed;
                    body.AddForceAtPosition(-velocity / speed * drag, hit.point, ForceMode.Force);
                }
            }
            Hydroplaning = wheels.Length > 0 ? sum / wheels.Length : 0f;
        }
    }
}
