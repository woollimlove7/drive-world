import * as THREE from "three";
import { getRobotMaterials, makeBox, makeCylinder, makeJoint } from "./RobotParts.js";

// ---------------------------------------------------------------------------
// MECHANICAL SENTINEL -- standard melee grunt enemy.
//
// Hierarchy (see brief's "MECHANICAL ROBOT MODEL ARCHITECTURE"):
//
// root (feet on ground, y=0 local)
//  └─ hips (waist pivot)
//      ├─ torso
//      │   ├─ head (bobs/turns independently -- sensor)
//      │   ├─ leftShoulder -> leftUpperArm -> leftElbow -> leftForearm
//      │   └─ rightShoulder -> rightUpperArm -> rightElbow -> rightForearm
//      ├─ leftHip -> leftThigh -> leftKnee -> leftShin
//      └─ rightHip -> rightThigh -> rightKnee -> rightShin
//
// Every joint is a THREE.Group so EnemyAnimator can just set
// joint.rotation.x/y/z per frame -- no skinning, no external rig, which
// keeps this dependency-free and consistent with the project's existing
// procedural-animation style (Target.js's bob/spin).
//
// Geometry/materials all come from RobotParts.js's shared caches -- only
// the eye-glow and armor tint materials are cloned per-instance (so
// damage-flash color changes don't leak across enemies), matching the
// pattern in Target.js's createSharedTargetAssets / this.material.clone().
// ---------------------------------------------------------------------------

const LEG_LENGTH = 1.0; // thigh + shin, roughly
const TORSO_HEIGHT = 0.78;
const HIP_Y = LEG_LENGTH; // ground -> hips
const SHOULDER_Y = HIP_Y + TORSO_HEIGHT * 0.82;

export function buildMechanicalEnemyModel() {
  const mats = getRobotMaterials();
  const eyeGlow = mats.eyeGlow.clone();
  const armorTint = mats.armor.clone();

  const root = new THREE.Group();

  // ---- hips / waist -------------------------------------------------
  const hips = makeJoint([0, HIP_Y, 0]);
  root.add(hips);

  const pelvis = makeBox(null, 0.62, 0.32, 0.4, mats.armorDark);
  pelvis.position.y = 0.06;
  hips.add(pelvis);

  // ---- torso ----------------------------------------------------------
  const torso = makeBox(null, 0.7, TORSO_HEIGHT, 0.46, armorTint);
  torso.position.y = TORSO_HEIGHT / 2 + 0.16;
  hips.add(torso);

  const chestPlate = makeBox(null, 0.5, 0.4, 0.08, mats.jointMetal);
  chestPlate.position.set(0, TORSO_HEIGHT * 0.55, 0.27);
  torso.add(chestPlate);

  // ---- head / sensor ----------------------------------------------------
  const headJoint = makeJoint([0, TORSO_HEIGHT + 0.14, 0]);
  torso.add(headJoint);

  const head = makeBox(null, 0.34, 0.32, 0.34, mats.armorDark);
  headJoint.add(head);

  const eye = makeBox(eyeGlow, 0.2, 0.06, 0.05, eyeGlow);
  eye.position.set(0, 0.02, 0.18);
  headJoint.add(eye);

  // ---- arms -------------------------------------------------------------
  function buildArm(side) {
    const sign = side === "left" ? 1 : -1;
    const shoulder = makeJoint([sign * 0.46, TORSO_HEIGHT - 0.06, 0]);
    torso.add(shoulder);

    const shoulderPad = makeBox(null, 0.28, 0.22, 0.28, mats.jointMetal);
    shoulderPad.position.set(sign * 0.08, 0, 0);
    shoulder.add(shoulderPad);

    const upperArmLen = 0.42;
    const upperArmJoint = makeJoint([sign * 0.1, -0.02, 0]);
    shoulder.add(upperArmJoint);

    const upperArm = makeCylinder(0.32, upperArmLen, armorTint);
    upperArm.position.y = -upperArmLen / 2;
    upperArmJoint.add(upperArm);

    const elbow = makeJoint([0, -upperArmLen, 0]);
    upperArmJoint.add(elbow);

    const forearmLen = 0.4;
    const forearm = makeCylinder(0.26, forearmLen, mats.hydraulic);
    forearm.position.y = -forearmLen / 2;
    elbow.add(forearm);

    const fist = makeBox(null, 0.26, 0.2, 0.26, mats.jointMetal);
    fist.position.y = -forearmLen - 0.08;
    elbow.add(fist);

    return { shoulder, upperArmJoint, elbow, forearm, fist };
  }

  const leftArm = buildArm("left");
  const rightArm = buildArm("right");

  // ---- legs ---------------------------------------------------------
  function buildLeg(side) {
    const sign = side === "left" ? 1 : -1;
    const hipJoint = makeJoint([sign * 0.22, -0.05, 0]);
    hips.add(hipJoint);

    const thighLen = 0.52;
    const thigh = makeCylinder(0.34, thighLen, armorTint);
    thigh.position.y = -thighLen / 2;
    hipJoint.add(thigh);

    const knee = makeJoint([0, -thighLen, 0]);
    hipJoint.add(knee);

    const shinLen = 0.48;
    const shin = makeCylinder(0.28, shinLen, mats.hydraulic);
    shin.position.y = -shinLen / 2;
    knee.add(shin);

    const foot = makeBox(null, 0.32, 0.14, 0.5, mats.jointMetal);
    foot.position.set(0, -shinLen - 0.06, 0.08);
    knee.add(foot);

    return { hipJoint, knee, shin };
  }

  const leftLeg = buildLeg("left");
  const rightLeg = buildLeg("right");

  return {
    root,
    parts: {
      hips,
      torso,
      headJoint,
      eyeMaterial: eyeGlow,
      armorMaterial: armorTint,
      leftArm,
      rightArm,
      leftLeg,
      rightLeg
    }
  };
}

export const MECHANICAL_ENEMY_HEIGHT = HIP_Y + TORSO_HEIGHT + 0.5;
export const MECHANICAL_ENEMY_SHOULDER_Y = SHOULDER_Y;