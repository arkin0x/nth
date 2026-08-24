/**
 * landfall.ts: DECK-0001 v3 §1.2, the landfall derivation.
 *
 * A block whose merkle root has plane bit 0 lands on Earth: its stop
 * coordinate is the point where a direction chosen by
 * sha256(LANDFALL_DOMAIN || block_hash) meets the WGS84 ellipsoid.
 * Consensus-critical: runs in the base spec's decimal profile (precision 96,
 * ROUND_HALF_EVEN, the exact PI_STR, deterministic Taylor sin/cos) with every
 * operation in the order the DECK lists. Verified against the DECK's eight
 * golden vectors; the ONOSENDAI client and the Python reference produce
 * byte-identical output.
 */
import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';

const LANDFALL_DOMAIN = Buffer.from('CYBERSPACE_LANDFALL_V1', 'ascii');

const D = Decimal.clone({ precision: 96, rounding: Decimal.ROUND_HALF_EVEN });

const PI_STR =
  '3.1415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679';
const PI = new D(PI_STR);
const TWO_PI = PI.times(2);
const HALF_PI = PI.div(2);
const TRIG_EPS = new D('1e-88');
const TRIG_MAX_ITER = 256;

const WGS84_A_M = new D('6378137');
const WGS84_F = new D(1).div('298.257223563');
const WGS84_B_M = WGS84_A_M.times(new D(1).minus(WGS84_F));

const AXIS_BITS = 85;
const AXIS_MAX = (1n << BigInt(AXIS_BITS)) - 1n;
const AXIS_CENTER = 1n << BigInt(AXIS_BITS - 1);
const UNITS_PER_KM = new D(1000).times(new D(2).pow(33));
const TWO_128 = new D(2).pow(128);

function truncMod(x: Decimal, m: Decimal): Decimal {
  // Python Decimal %: truncated toward zero, sign of the dividend.
  return x.minus(m.times(x.dividedToIntegerBy(m)));
}

function sinCos(xIn: Decimal): { sin: Decimal; cos: Decimal } {
  let x = truncMod(xIn, TWO_PI);
  if (x.gt(PI)) x = x.minus(TWO_PI);
  let cosSign = new D(1);
  if (x.gt(HALF_PI)) {
    x = PI.minus(x);
    cosSign = new D(-1);
  } else if (x.lt(HALF_PI.neg())) {
    x = PI.neg().minus(x);
    cosSign = new D(-1);
  }
  const x2 = x.times(x);
  let sinSum = x;
  let sinTerm = x;
  let converged = false;
  for (let k = 1; k <= TRIG_MAX_ITER; k++) {
    sinTerm = sinTerm.neg().times(x2).div(new D(2 * k).times(2 * k + 1));
    sinSum = sinSum.plus(sinTerm);
    if (sinTerm.abs().lt(TRIG_EPS)) {
      converged = true;
      break;
    }
  }
  if (!converged) throw new Error('sin() Taylor series did not converge');
  let cosSum = new D(1);
  let cosTerm = new D(1);
  converged = false;
  for (let k = 1; k <= TRIG_MAX_ITER; k++) {
    cosTerm = cosTerm.neg().times(x2).div(new D(2 * k - 1).times(2 * k));
    cosSum = cosSum.plus(cosTerm);
    if (cosTerm.abs().lt(TRIG_EPS)) {
      converged = true;
      break;
    }
  }
  if (!converged) throw new Error('cos() Taylor series did not converge');
  return { sin: sinSum, cos: cosSum.times(cosSign) };
}

function kmToAxisU(kmFromCenter: Decimal): bigint {
  const u = kmFromCenter.times(UNITS_PER_KM).plus(new D(AXIS_CENTER.toString()));
  let uInt = BigInt(u.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toFixed(0));
  if (uInt < 0n) uInt = 0n;
  if (uInt > AXIS_MAX) uInt = AXIS_MAX;
  return uInt;
}

function xyzToCoord(x: bigint, y: bigint, z: bigint, plane: bigint): bigint {
  let coord = plane & 1n;
  for (let i = 0n; i < BigInt(AXIS_BITS); i++) {
    coord |= ((z >> i) & 1n) << (1n + i * 3n);
    coord |= ((y >> i) & 1n) << (2n + i * 3n);
    coord |= ((x >> i) & 1n) << (3n + i * 3n);
  }
  return coord;
}

/** The landfall coord256 for a block hash (64 lowercase hex in, 64 out). */
export function landfallCoordHex(blockHashHex: string): string {
  const hex = blockHashHex.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Invalid block hash hex: ${blockHashHex}`);
  }
  const seed = createHash('sha256')
    .update(Buffer.concat([LANDFALL_DOMAIN, Buffer.from(hex, 'hex')]))
    .digest();
  const u1 = new D(BigInt('0x' + seed.subarray(0, 16).toString('hex')).toString()).div(TWO_128);
  const u2 = new D(BigInt('0x' + seed.subarray(16, 32).toString('hex')).toString()).div(TWO_128);
  const lon = new D(2).times(u1).minus(1).times(PI);
  const z = new D(2).times(u2).minus(1);
  const rxy = new D(1).minus(z.times(z)).sqrt();
  const { sin: sinLon, cos: cosLon } = sinCos(lon);
  const dx = rxy.times(cosLon);
  const dy = rxy.times(sinLon);
  const dz = z;
  const inv = dx
    .times(dx)
    .plus(dy.times(dy))
    .div(WGS84_A_M.times(WGS84_A_M))
    .plus(dz.times(dz).div(WGS84_B_M.times(WGS84_B_M)))
    .sqrt();
  const r = new D(1).div(inv);
  const km = new D(1000);
  // Axis permutation per CYBERSPACE_V2 §9.4: X_cs = X_ecef, Y_cs = Z_ecef, Z_cs = Y_ecef.
  const x = kmToAxisU(r.times(dx).div(km));
  const y = kmToAxisU(r.times(dz).div(km));
  const zc = kmToAxisU(r.times(dy).div(km));
  return xyzToCoord(x, y, zc, 0n).toString(16).padStart(64, '0');
}

/** The plane bit of a merkle root: 1 = port (ideaspace), 0 = landfall (Earth). */
export function planeOfMerkleRoot(merkleRootHex: string): 0 | 1 {
  const last = merkleRootHex[merkleRootHex.length - 1];
  return (parseInt(last, 16) & 1) as 0 | 1;
}
