import * as THREE from "three";
import { getRobotMaterials, makeBox, makeCylinder, makeSphere, makeJoint } from "./RobotParts.js";

// ---------------------------------------------------------------------------
// APEX ARACHNID -- large mechanical spider boss.
//
// NOT a scaled-up grunt (brief explicitly calls this out): unique chassis,
// six articulated legs (three per side, alternating tripod gait -- see
// SpiderAnimator.js), a glowing central reactor core, and two shoulder-
// mounted rocket launcher pods used for the special attack telegraph.
//
// Hierarchy:
//
// root (feet/ground contact plane, y=0 local before scale)
//  └─ chassis (the body, held up by the legs conceptually -- legs are
//     attached to it, chassis itself does not procedurally "stand" on
//     leg IK; this is a stylized walker, not simulated physics)
//      ├─ core (emissive reactor sphere)
//      ├─ head/sensor cluster (front, tracks target)
//      ├─ rocketPodL / rocketPodR (glow + recoil during rocket launch)
//      └─ leg[0..5] -> hip -> thigh -> knee -> shin -> foot
//
// Shares RobotParts.js geometry/material caches with the grunt so both
// factions read as the same mechanical faction, per the brief.
// ---------------------------------------------------------------------------

const CHASSIS_Y = 1.6; // ground -> chassis center, before the boss's overall config.scale

// Leg mount points around the chassis: [x, z, forward-facing angle]
const LEG_MOUNTS = [
  { x: 1.1, z: 0.9, side: 1 },
  { x: 1.3, z: 0.0, side: 1 },
  { x: 1.1, z: -0.9, side: 1 },
  { x: -1.1, z: 0.9, side: -1 },
  { x: -1.3, z: 0.0, side: -1 },
  { x: -1.1, z: -0.9, side: -1 }
];

export function buildBossSpiderModel() {
  const mats = getRobotMaterials();
  const coreMat = mats.bossCore.clone();
  const eyeMat = mats.eyeGlow.clone();
  const rocketGlow = mats.bossCore.clone();

  const root = new THREE.Group();

  const chassis = makeJoint([0, CHASSIS_Y, 0]);
  root.add(chassis);

  const body = makeBox(null, 2.1, 0.9, 2.6, mats.bossArmor);
  chassis.add(body);

  const underPlate = makeBox(null, 1.6, 0.3, 2.0, mats.bossArmorDark);
  underPlate.position.y = -0.5;
  chassis.add(underPlate);

  const core = makeSphere(0.45, coreMat);
  core.position.set(0, 0.55, 0);
  chassis.add(core);

  // ---- head / sensor cluster (front-facing, tracks target yaw a bit) ----
  const headJoint = makeJoint([0, 0.35, 1.2]);
  chassis.add(headJoint);
  const head = makeBox(null, 0.7, 0.4, 0.6, mats.bossArmorDark);
  headJoint.add(head);
  const eye = makeBox(eyeMat, 0.35, 0.12, 0.05, eyeMat);
  eye.position.set(0, 0.02, 0.32);
  headJoint.add(eye);

  // ---- rocket launcher pods (shoulder-mounted, glow during telegraph) --
  // Sized to read clearly as a weapon on its own (not just "bigger because
  // the whole boss scaled up"): a chunkier housing, a distinct darker
  // muzzle-rim mesh so the barrel opening is visible face-on, and a
  // brighter charge glow.
  function buildRocketPod(side) {
    const pod = makeJoint([side * 1.15, 0.5, -0.6]);
    chassis.add(pod);
    const housing = makeCylinder(0.36, 1.15, mats.bossArmorDark);
    housing.rotation.z = Math.PI / 2;
    housing.position.x = side * 0.55;
    pod.add(housing);

    // Muzzle rim -- a short, slightly wider cylinder capping the front of
    // the housing so the opening reads as a real barrel mouth rather than
    // the housing just trailing off.
    const muzzleRim = makeCylinder(0.4, 0.14, mats.jointMetal);
    muzzleRim.rotation.z = Math.PI / 2;
    muzzleRim.position.x = side * 1.12;
    pod.add(muzzleRim);

    const glow = makeSphere(0.22, rocketGlow);
    glow.position.set(side * 1.12, 0, 0);
    pod.add(glow);
    return { pod, glow };
  }

  const rocketPodL = buildRocketPod(1);
  const rocketPodR = buildRocketPod(-1);

  // ---- legs ---------------------------------------------------------
  function buildLeg(mount, index) {
    const hip = makeJoint([mount.x, 0, mount.z]);
    chassis.add(hip);

    const thighLen = 1.0;
    const thighJoint = makeJoint([mount.side * 0.15, -0.05, 0]);
    hip.add(thighJoint);
    const thigh = makeCylinder(0.22, thighLen, mats.bossArmor);
    thigh.rotation.z = mount.side * (Math.PI / 5);
    thigh.position.set(mount.side * Math.sin(Math.PI / 5) * (thighLen / 2), -Math.cos(Math.PI / 5) * (thighLen / 2), 0);
    thighJoint.add(thigh);

    const knee = makeJoint([mount.side * Math.sin(Math.PI / 5) * thighLen, -Math.cos(Math.PI / 5) * thighLen, 0]);
    thighJoint.add(knee);

    const shinLen = 1.1;
    const shin = makeCylinder(0.16, shinLen, mats.hydraulic);
    shin.position.y = -shinLen / 2;
    knee.add(shin);

    const foot = makeSphere(0.14, mats.jointMetal);
    foot.position.y = -shinLen - 0.05;
    knee.add(foot);

    return { index, hip, thighJoint, knee, shin, side: mount.side };
  }

  const legs = LEG_MOUNTS.map((mount, i) => buildLeg(mount, i));

  return {
    root,
    parts: {
      chassis,
      headJoint,
      core,
      coreMaterial: coreMat,
      eyeMaterial: eyeMat,
      rocketGlowMaterial: rocketGlow,
      rocketPodL,
      rocketPodR,
      legs
    }
  };
}

export const BOSS_SPIDER_STANCE_HEIGHT = CHASSIS_Y + 0.9;