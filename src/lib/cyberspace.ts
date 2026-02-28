export type Sector = {
  sx: bigint;
  sy: bigint;
  sz: bigint;
};

export type CoordXYZ = {
  x: bigint;
  y: bigint;
  z: bigint;
  plane: 0n | 1n;
};

const AXIS_BITS = 85n;
const SECTOR_SHIFT = 30n;

export function coordHexToBigInt(coordHex: string): bigint {
  const hex = coordHex.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Invalid coord256 hex (expected 32 bytes / 64 hex chars): ${coordHex}`);
  }
  return BigInt('0x' + hex);
}

// Spec: CYBERSPACE_V2.md §2.1
// - bit 0: plane
// - bits 3,6,9,...: X bits
// - bits 2,5,8,...: Y bits
// - bits 1,4,7,...: Z bits
export function coordHexToXYZ(coordHex: string): CoordXYZ {
  const coord = coordHexToBigInt(coordHex);

  const plane = (coord & 1n) as 0n | 1n;

  let x = 0n;
  let y = 0n;
  let z = 0n;

  for (let i = 0n; i < AXIS_BITS; i++) {
    const zBit = (coord >> (1n + i * 3n)) & 1n;
    const yBit = (coord >> (2n + i * 3n)) & 1n;
    const xBit = (coord >> (3n + i * 3n)) & 1n;

    z |= zBit << i;
    y |= yBit << i;
    x |= xBit << i;
  }

  return { x, y, z, plane };
}

export function xyzToSector(xyz: CoordXYZ): Sector {
  return {
    sx: xyz.x >> SECTOR_SHIFT,
    sy: xyz.y >> SECTOR_SHIFT,
    sz: xyz.z >> SECTOR_SHIFT,
  };
}

export function coordHexToSector(coordHex: string): Sector {
  return xyzToSector(coordHexToXYZ(coordHex));
}

export function sectorToTags(sector: Sector): [string, string][] {
  const sx = sector.sx.toString(10);
  const sy = sector.sy.toString(10);
  const sz = sector.sz.toString(10);
  return [
    ['X', sx],
    ['Y', sy],
    ['Z', sz],
    ['S', `${sx}-${sy}-${sz}`],
  ];
}
