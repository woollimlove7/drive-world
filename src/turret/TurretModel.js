import * as THREE from "three";

// ---------------------------------------------------------------------------
// Geometry / material builders for the transforming roof turret.
//
// The assembly is deliberately built from independently-animatable parts
// (see TurretPose.js) rather than a single mesh: four roof hatch panels,
// a rising piston/lift column, a yawing turret body, a pitching gun mount,
// and a telescoping barrel. Everything here only *builds* the hierarchy --
// none of it knows about deploy state, aiming, or firing.
//
// Geometries and materials are created once per assembly (one per vehicle,
// local or remote) and reused across every mesh that shares a look, in
// keeping with the rest of the project's vehicle builders.
// ---------------------------------------------------------------------------

function addMesh(parent, geometry, material, position, rotation) {
  const mesh = new THREE.Mesh(geometry, material);
  if (position) mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function group(parent, position) {
  const g = new THREE.Group();
  if (position) g.position.set(...position);
  parent.add(g);
  return g;
}

function createMaterials(paintColor) {
  return {
    // Painted to match the vehicle's own body color so the closed hatch
    // reads as part of the roof rather than a bolted-on accessory. When
    // attached under the local vehicle's root this is later recolored
    // automatically alongside the rest of the body paint (see
    // MultiplayerClient.collectPaintMaterials).
    paint: new THREE.MeshStandardMaterial({
      color: paintColor,
      metalness: 0.5,
      roughness: 0.35
    }),

    gunmetal: new THREE.MeshStandardMaterial({
      color: 0x2a2f36,
      metalness: 0.8,
      roughness: 0.35
    }),

    darkTrim: new THREE.MeshStandardMaterial({
      color: 0x14171c,
      metalness: 0.4,
      roughness: 0.6
    }),

    hydraulic: new THREE.MeshStandardMaterial({
      color: 0x8b9096,
      metalness: 0.9,
      roughness: 0.25
    }),

    barrel: new THREE.MeshStandardMaterial({
      color: 0x1b1e22,
      metalness: 0.85,
      roughness: 0.3
    }),

    statusLight: new THREE.MeshStandardMaterial({
      color: 0x2fe37a,
      emissive: 0x1fbf5e,
      emissiveIntensity: 0.8
    }),

    muzzleFlash: new THREE.MeshBasicMaterial({
      color: 0xffddaa,
      transparent: true,
      opacity: 0,
      depthWrite: false
    })
  };
}

// One roof panel: a pivot group at the hinge line, with the panel slab
// offset so it swings open from that edge rather than from its own center.
function createPanel(mat, hinge, slabOffset, size) {
  const pivot = new THREE.Group();
  pivot.position.set(...hinge);

  addMesh(pivot, new THREE.BoxGeometry(...size), mat.paint, slabOffset);

  // Thin dark trim seam along the outer edge, so the panel reads as a
  // distinct mechanical piece rather than a plain paint slab.
  addMesh(
    pivot,
    new THREE.BoxGeometry(size[0] * 0.94, 0.012, size[2] * 0.94),
    mat.darkTrim,
    [slabOffset[0], slabOffset[1] + size[1] / 2 + 0.006, slabOffset[2]]
  );

  return pivot;
}

export function createTurretAssembly(paintColor) {
  const mat = createMaterials(paintColor);
  const root = new THREE.Group();

  // ---- Static hatch frame (always visible, flush with the roof) ---------
  const frame = addMesh(
    root,
    new THREE.BoxGeometry(0.86, 0.03, 0.86),
    mat.darkTrim,
    [0, 0.005, 0]
  );

  const statusLight = addMesh(
    root,
    new THREE.CylinderGeometry(0.03, 0.03, 0.01, 12),
    mat.statusLight,
    [0, 0.022, 0.4],
    [Math.PI / 2, 0, 0]
  );

  // ---- Four hinged roof panels -------------------------------------------
  // Left / right open by rotating about the vehicle's Z (front-back) axis;
  // front / rear open about the X (left-right) axis. Different axes so the
  // four panels visibly separate in different directions rather than all
  // popping open the same way.
  const leftPanel = createPanel(
    mat,
    [-0.39, 0.02, 0],
    [0.195, 0, 0],
    [0.39, 0.05, 0.76]
  );
  root.add(leftPanel);

  const rightPanel = createPanel(
    mat,
    [0.39, 0.02, 0],
    [-0.195, 0, 0],
    [0.39, 0.05, 0.76]
  );
  root.add(rightPanel);

  // Sit a hair above the left/right panels (rather than exactly coplanar)
  // so the two overlapping pairs read as stacked armor plates instead of
  // z-fighting when the hatch is closed.
  const frontPanel = createPanel(
    mat,
    [0, 0.052, 0.39],
    [0, 0, -0.195],
    [0.76, 0.05, 0.39]
  );
  root.add(frontPanel);

  const rearPanel = createPanel(
    mat,
    [0, 0.052, -0.39],
    [0, 0, 0.195],
    [0.76, 0.05, 0.39]
  );
  root.add(rearPanel);

  // ---- Lift column (piston mechanism that rises out of the hatch) -------
  const liftColumn = group(root, [0, -0.16, 0]);

  addMesh(
    liftColumn,
    new THREE.CylinderGeometry(0.1, 0.11, 0.3, 12),
    mat.gunmetal,
    [0, 0.15, 0]
  );

  // Three thin hydraulic piston rods around the main column.
  for (let i = 0; i < 3; i++) {
    const angle = (Math.PI * 2 * i) / 3;

    addMesh(
      liftColumn,
      new THREE.CylinderGeometry(0.022, 0.022, 0.34, 8),
      mat.hydraulic,
      [Math.cos(angle) * 0.14, 0.17, Math.sin(angle) * 0.14]
    );
  }

  // ---- Turret body (yaw pivot) -------------------------------------------
  const turretYaw = group(liftColumn, [0, 0.32, 0]);

  const bodyShell = group(turretYaw, [0, 0, 0]);

  addMesh(
    bodyShell,
    new THREE.CylinderGeometry(0.19, 0.22, 0.24, 8),
    mat.gunmetal,
    [0, 0.12, 0]
  );

  // Small armor vents, purely decorative, break up the plain cylinder.
  for (let i = 0; i < 4; i++) {
    const angle = (Math.PI * 2 * i) / 4 + Math.PI / 4;

    addMesh(
      bodyShell,
      new THREE.BoxGeometry(0.05, 0.14, 0.03),
      mat.darkTrim,
      [Math.cos(angle) * 0.19, 0.12, Math.sin(angle) * 0.19],
      [0, -angle, 0]
    );
  }

  // ---- Gun mount (pitch pivot) -------------------------------------------
  const gunMountPivot = group(turretYaw, [0, 0.26, 0.06]);

  addMesh(
    gunMountPivot,
    new THREE.BoxGeometry(0.16, 0.16, 0.2),
    mat.gunmetal,
    [0, 0, 0.05]
  );

  // Side support arms connecting the mount back to the body.
  for (const side of [-1, 1]) {
    addMesh(
      gunMountPivot,
      new THREE.BoxGeometry(0.04, 0.04, 0.22),
      mat.hydraulic,
      [side * 0.11, 0, -0.02]
    );
  }

  // ---- Telescoping barrel -------------------------------------------------
  const barrelGroup = group(gunMountPivot, [0, 0.01, 0.16]);
  const barrelLength = 0.5;

  const barrelGeometry = new THREE.CylinderGeometry(0.045, 0.05, barrelLength, 12);
  barrelGeometry.rotateX(Math.PI / 2);
  // Shift so the geometry's "back" sits at local origin; scaling the mesh
  // then extends it forward instead of from its center (see TurretPose.js).
  barrelGeometry.translate(0, 0, barrelLength / 2);

  const barrelMesh = new THREE.Mesh(barrelGeometry, mat.barrel);
  barrelMesh.castShadow = true;
  barrelGroup.add(barrelMesh);

  addMesh(
    barrelGroup,
    new THREE.CylinderGeometry(0.055, 0.055, 0.05, 12),
    mat.gunmetal,
    [0, 0, 0.02],
    [Math.PI / 2, 0, 0]
  );

  const muzzleTip = group(barrelGroup, [0, 0, barrelLength]);

  const muzzleFlash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.28, 0.28),
    mat.muzzleFlash
  );
  muzzleFlash.position.z = 0.02;
  muzzleFlash.rotation.y = Math.PI / 2;
  muzzleTip.add(muzzleFlash);

  return {
    root,
    parts: {
      frame,
      statusLight,
      leftPanel,
      rightPanel,
      frontPanel,
      rearPanel,
      liftColumn,
      turretYaw,
      bodyShell,
      gunMountPivot,
      barrelGroup,
      barrelMesh,
      muzzleTip,
      muzzleFlash
    },
    materials: mat,
    barrelLength
  };
}
