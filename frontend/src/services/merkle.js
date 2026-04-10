import { Buffer } from "buffer";
import { MerkleTree } from "merkletreejs";
import { sha256 } from "js-sha256";

const hashFn = (value) => Buffer.from(sha256.array(value));

function stripHexPrefix(value) {
  return value.startsWith("0x") ? value.slice(2) : value;
}

export function verifyMerkleProofInBrowser(leafHash, merkleProof, merkleRoot) {
  if (!leafHash || !merkleRoot) {
    return false;
  }

  const tree = new MerkleTree([], hashFn, { sortPairs: true });
  const formattedProof = (merkleProof || []).map((step) => ({
    position: step.position === "left" ? "left" : "right",
    data: Buffer.from(stripHexPrefix(step.hash), "hex"),
  }));

  const leafBuffer = Buffer.from(stripHexPrefix(leafHash), "hex");
  const rootBuffer = Buffer.from(stripHexPrefix(merkleRoot), "hex");

  return tree.verify(formattedProof, leafBuffer, rootBuffer);
}
