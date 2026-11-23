/**
 * Test rigs: thin, typed wrappers around the extracted procedural aircraft plus the
 * minimal aquaplaning test car and the procedural sports coupe. Every rig uses the engine convention
 * **forward = -Z, right = +X, up = +Y, metres** so physics and effects code is shared.
 */
export { createBeaverRig, type BeaverRig } from './beaver';
export { createJetRig, JET_IDS, type JetId, type JetRig } from './jets';
export { createTestCar, type TestCarRig } from './test-car';
export { createSportsCoupe, type SportsCoupeRig } from './sports-coupe';
