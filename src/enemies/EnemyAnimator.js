// ---------------------------------------------------------------------------
// Procedural animation for MechanicalEnemyModel. One reusable function,
// called every frame with the model's `parts` (from buildMechanicalEnemyModel)
// plus a small animState descriptor -- no clips, no skinning, just phase-
// driven joint rotations. Kept in one place so grunt animation logic is
// never duplicated per-instance (brief: "reusable animation functions").
//
// animState shape:
//   {
//     mode: "idle" | "walk" | "hurt" | "dead",
//     attackPhase: null | "windup" | "strike" | "recovery",
//     attackPhaseT: 0..1,   // progress within attackPhase
//     moveT: 0..1,          // walk-cycle phase accumulator (caller advances)
//     hurtT: 0..1,          // 1 = just hit, decays to 0
//     deathT: 0..1          // 0 = alive, 1 = fully collapsed
//   }
// ---------------------------------------------------------------------------

export function animateMechanicalEnemy(parts, elapsed, animState) {
  const { hips, torso, headJoint, leftArm, rightArm, leftLeg, rightLeg } = parts;

  if (animState.deathT > 0) {
    animateDeath(parts, animState.deathT);
    return;
  }

  // ---- idle micro-motion (always applied as a base layer) --------------
  const idleBob = Math.sin(elapsed * 2.2) * 0.02;
  const idleSway = Math.sin(elapsed * 1.3) * 0.015;
  torso.rotation.z = idleSway;
  headJoint.rotation.y = Math.sin(elapsed * 0.7) * 0.25;
  headJoint.rotation.x = Math.sin(elapsed * 1.9) * 0.03;

  if (animState.mode === "walk") {
    const walkCycle = animState.moveT * Math.PI * 2;
    const swing = 0.55;
    leftLeg.hipJoint.rotation.x = Math.sin(walkCycle) * swing;
    rightLeg.hipJoint.rotation.x = Math.sin(walkCycle + Math.PI) * swing;
    leftLeg.knee.rotation.x = Math.max(0, -Math.sin(walkCycle) * 0.8);
    rightLeg.knee.rotation.x = Math.max(0, -Math.sin(walkCycle + Math.PI) * 0.8);

    // Arm counterbalance -- opposite phase to the same-side leg.
    leftArm.shoulder.rotation.x = Math.sin(walkCycle + Math.PI) * 0.35;
    rightArm.shoulder.rotation.x = Math.sin(walkCycle) * 0.35;

    hips.position.y = 1.0 + Math.abs(Math.sin(walkCycle * 2)) * 0.04 + idleBob;
    torso.rotation.y = Math.sin(walkCycle) * 0.05;
  } else {
    // Idle stance -- subtle piston/servo shifting, weight settle.
    leftLeg.hipJoint.rotation.x = 0;
    rightLeg.hipJoint.rotation.x = 0;
    leftLeg.knee.rotation.x = 0;
    rightLeg.knee.rotation.x = 0;
    leftArm.shoulder.rotation.x = Math.sin(elapsed * 1.1) * 0.04;
    rightArm.shoulder.rotation.x = Math.sin(elapsed * 1.1 + Math.PI) * 0.04;
    hips.position.y = 1.0 + idleBob;
    torso.rotation.y = 0;
  }

  // ---- melee attack overlay (right arm) ---------------------------------
  if (animState.attackPhase === "windup") {
    const t = animState.attackPhaseT;
    rightArm.shoulder.rotation.x = -1.9 * t;
    rightArm.upperArmJoint.rotation.x = -0.6 * t;
    torso.rotation.y = -0.18 * t;
  } else if (animState.attackPhase === "strike") {
    const t = animState.attackPhaseT;
    rightArm.shoulder.rotation.x = -1.9 + 2.7 * t;
    rightArm.upperArmJoint.rotation.x = -0.6 + 1.1 * t;
    torso.rotation.y = -0.18 + 0.3 * t;
  } else if (animState.attackPhase === "recovery") {
    const t = animState.attackPhaseT;
    rightArm.shoulder.rotation.x = 0.8 * (1 - t);
    rightArm.upperArmJoint.rotation.x = 0.5 * (1 - t);
    torso.rotation.y = 0.12 * (1 - t);
  }

  // ---- hurt reaction overlay --------------------------------------------
  if (animState.hurtT > 0) {
    const k = animState.hurtT;
    torso.rotation.x = -0.25 * k;
    headJoint.rotation.x += -0.15 * k;
  } else {
    torso.rotation.x = 0;
  }
}

function animateDeath(parts, deathT) {
  // Loss of stability -> mechanical collapse -> disabled posture.
  const t = Math.min(1, deathT);
  parts.hips.rotation.z = t * 0.35;
  parts.torso.rotation.x = t * 1.3;
  parts.torso.rotation.z = t * 0.4;
  parts.hips.position.y = 1.0 - t * 0.9;
  parts.headJoint.rotation.x = t * 0.6;
  parts.leftArm.shoulder.rotation.z = t * 0.9;
  parts.rightArm.shoulder.rotation.z = -t * 0.7;
}