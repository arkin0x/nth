import { Decimal } from 'decimal.js'
import { DecimalVector3 } from './DecimalVector3.js'

export type Plane = "d-space" | "i-space"
 
export const CYBERSPACE_SECTOR = new Decimal(2).pow(30)

// Cyberspace X/Y/Z coordinates must be reprersented by Decimal objects that can represent the truly huge values.
export type CyberspaceCoordinates = {
  x: Decimal
  y: Decimal
  z: Decimal 
  plane: Plane
}

/**
 * Simple function to take a 0 or 1 in string or number format and output the plane as either 'd-space' or 'i-space'.
 * @param bin 0 or 1
 * @returns Plane
 */
export const binToPlane = (bin: string|number): 'i-space' | 'd-space' => {
  return parseInt(bin.toString()) > 0 ? 'i-space' : 'd-space'
}

/**
 * Convert a hex string to a Decimal.js-based CyberspaceCoordinates object.
 * @param hexString hexadecimal string
 * @returns CyberspaceCoordinates
 */
export function decodeHexToCoordinates(hexString: string): CyberspaceCoordinates {
    // Checking if the input string is a valid 64 character hexadecimal string
    if (!/^([0-9A-Fa-f]{64})$/.test(hexString)) {
        throw new Error("Invalid hexadecimal string.")
    }

    // Initialize the coordinates
    let X = BigInt(0)
    let Y = BigInt(0)
    let Z = BigInt(0)

    // Convert hex string to binary
    const binaryString = BigInt("0x" + hexString).toString(2).padStart(256, '0')

    // Traverse through the binary string
    for (let i = 0; i < 255; i++) {
        switch (i % 3) {
            case 0:
                X = (X << BigInt(1)) | BigInt(binaryString[i])
                break
            case 1:
                Y = (Y << BigInt(1)) | BigInt(binaryString[i])
                break
            case 2:
                Z = (Z << BigInt(1)) | BigInt(binaryString[i])
                break
        }
    }

    const plane = binToPlane(binaryString)

    // convert bigints to decimal objects
    const decimalX = new Decimal(X.toString())
    const decimalY = new Decimal(Y.toString())
    const decimalZ = new Decimal(Z.toString())

    return {
      x: decimalX,
      y: decimalY,
      z: decimalZ,
      plane
    } as CyberspaceCoordinates
}

/**
 * Used for converting a hex cyberspace coordinate into a DecimalVector3 representing the sector id that the coordinate is in. Use getSectorId to turn the sector id into a string.
 * @param coordinate string
 * @returns DecimalVector3
 */
export const getSectorIdFromCoordinate = (coordinate: string): DecimalVector3 => {
  const coord: CyberspaceCoordinates = decodeHexToCoordinates(coordinate)

  const sectorX = coord.x.div(CYBERSPACE_SECTOR).floor()
  const sectorY = coord.y.div(CYBERSPACE_SECTOR).floor()
  const sectorZ = coord.z.div(CYBERSPACE_SECTOR).floor()
  
  const sector = new DecimalVector3(sectorX, sectorY, sectorZ)

  return sector
}

/**
 * Render the sector identifier from a DecimalVector3 sector. This is used in the "S" tag for querying objects in a sector.
 */
export const getSectorId = (sector: DecimalVector3): string => {
  return sector.toArray(0).join('-')
}