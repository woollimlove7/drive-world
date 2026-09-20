// ---------------------------------------------------------------------------
// Procedural animation for BossSpiderModel. Alternating tripod gait (legs
// 0,2,4 vs 1,3,5 -- front/back-left/right groups) rather than every leg
// moving identically, per the brief. Also handles the melee leg-strike and
// the rocket-launch pod recoil/glow.
//
// animState shape:
//   {
//     mode: "idle" | "walk" | "hurt" | "dead",
//     attackPhase: null | "windup" | "strike" | "recovery",
//     attackPhaseT: 0..1,
//     moveT: 0..1,
//     hurtT: 0..1,
//     deathT: 0..1,
//     rocketPhase: null | "telegraph" | "launching",
//     rocketPhaseT: 0..1
//   }
// ---------------------------------------------------------------------------

const TRIPOD_A = [0, 3, 4]; // frontL, midR, backL
const TRIPOD_B = [1, 2, 5]; // midL, frontR, backR

export function animateBossSpider(parts, elapsed, animState) {
  const { chassis, headJoint, core, legs, rocketPodL, rocketPodR } = parts;

  if (animState.deathT > 0) {
    animateSpiderDeath(parts, animState.deathT);
    return;
  }

  const idleBob = Math.sin(elapsed * 1.1) * 0.03;
  chassis.position.y = idleBob;
  chassis.rotation.z = Math.sin(elapsed * 0.6) * 0.015;
  headJoint.rotation.y = Math.sin(elapsed * 0.5) * 0.2;

  const coreScale = 1 + Math.sin(elapsed * 3.0) * 0.05;
  core.scale.setScalar(coreScale);

  if (animState.mode === "walk") {
    const cycle = animState.moveT * Math.PI * 2;
    for (const idx of TRIPOD_A) animateLeg(legs[idx], Math.sin(cycle));
    for (const idx of TRIPOD_B) animateLeg(legs[idx], Math.sin(cycle + Math.PI));
  } else {
    for (const leg of legs) animateLeg(leg, 0);
  }

  // ---- melee attack overlay: front two legs (0, 3) strike forward ----
  if (animState.attackPhase === "windup") {
    const t = animState.attackPhaseT;
    for (const idx of [0, 3]) {
      legs[idx].thighJoint.rotation.x = -0.5 * t;
    }
  } else if (animState.attackPhase === "strike") {
    const t = animState.attackPhaseT;
    for (const idx of [0, 3]) {
      legs[idx].thighJoint.rotation.x = -0.5 + 1.3 * t;
    }
    chassis.position.z = 0.15 * Math.sin(t * Math.PI);
  } else if (animState.attackPhase === "recovery") {
    const t = animState.attackPhaseT;
    for (const idx of [0, 3]) {
      legs[idx].thighJoint.rotation.x = 0.8 * (1 - t);
    }
  }

  // ---- rocket telegraph / launch overlay on the pods ----
  const podGlowBase = 1.6;
  if (animState.rocketPhase === "telegraph") {
    const pulse = 0.5 + 0.5 * Math.sin(animState.rocketPhaseT * 24);
    rocketPodL.glow.material.emissiveIntensity = podGlowBase + pulse * 2.5;
    rocketPodR.glow.material.emissiveIntensity = podGlowBase + pulse * 2.5;
    rocketPodL.pod.rotation.x = -0.2 * animState.rocketPhaseT;
    rocketPodR.pod.rotation.x = -0.2 * animState.rocketPhaseT;
  } else if (animState.rocketPhase === "launching") {
    const t = animState.rocketPhaseT;
    rocketPodL.glow.material.emissiveIntensity = podGlowBase;
    rocketPodR.glow.material.emissiveIntensity = podGlowBase;
    // Recoil kick that eases back out.
    const recoil = Math.max(0, 1 - t * 4);
    rocketPodL.pod.position.z = -0.6 - recoil * 0.3;
    rocketPodR.pod.position.z = -0.6 - recoil * 0.3;
  } else {
    rocketPodL.glow.material.emissiveIntensity = podGlowBase;
    rocketPodR.glow.material.emissiveIntensity = podGlowBase;
    rocketPodL.pod.position.z = -0.6;
    rocketPodR.pod.position.z = -0.6;
    rocketPodL.pod.rotation.x = 0;
    rocketPodR.pod.rotation.x = 0;
  }

  if (animState.hurtT > 0) {
    chassis.rotation.x = -0.06 * animState.hurtT;
  } else {
    chassis.rotation.x = 0;
  }
}

function animateLeg(leg, phase) {
  // phase in [-1, 1]: lift the thigh forward/back, flex the knee more
  // when the leg is "lifted" (phase > 0) so it reads as stepping rather
  // than sliding.
  leg.thighJoint.rotation.x = phase * 0.35;
  leg.knee.rotation.x = Math.max(0, phase) * 0.6;
}

function animateSpiderDeath(parts, deathT) {
  const t = Math.min(1, deathT);
  parts.chassis.position.y = -t * 1.1;
  parts.chassis.rotation.x = t * 0.5;
  parts.chassis.rotation.z = t * 0.3;
  for (const leg of parts.legs) {
    leg.thighJoint.rotation.x = t * 0.9 * (leg.side || 1) * 0.3 + t * 0.4;
    leg.knee.rotation.x = t * 1.1;
  }
}