// ---------------------------------------------------------------------------
// VehicleConfig.js
//
// Registry of selectable vehicle types. Today there is exactly one type, and
// nothing in the game lets a player pick a different one -- this file exists
// so that *when* that feature is built, it's a config entry + a builder
// function in VehicleVisual.js, not a rewrite of Vehicle.js/RemoteVehicle.js.
//
// To add a new vehicle type later:
//   1. Write a `build<Name>Body(root, color)` function in VehicleVisual.js
//      (copy buildSedanBody as a starting point).
//   2. Add an entry below pointing `id` at that function's key.
//   3. Extend the switch in VehicleVisual.js's buildVehicleBody() dispatcher.
// Nothing in Vehicle.js, RemoteVehicle.js, or Game.js needs to change.
// ---------------------------------------------------------------------------

export const VEHICLE_TYPES = {
  sedan: {
    id: "sedan",
    label: "Sedan"
  }
};

export const DEFAULT_VEHICLE_TYPE = "sedan";
