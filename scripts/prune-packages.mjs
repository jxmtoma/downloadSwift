import fs from "node:fs";

// Release packages are upload artifacts, not an archive: the two most recent
// versions stay in dist/ so the previous release remains grabbable while the
// older ones are deleted. dist/ is untracked, so this loses nothing the
// repository tags do not already preserve.
const VERSIONS_TO_KEEP = 2;
const dist = "dist";
const patterns = [
  /^downloadswift-(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)\.zip$/,
  /^downloadswift-(?:firefox|safari)-(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)\.zip$/,
  /^downloadswift-firefox-source-(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)\.zip$/
];

const versionOf = (name) => {
  for (const pattern of patterns) {
    const match = pattern.exec(name);
    if (match) return match[1];
  }
  return null;
};

const compareVersions = (left, right) => {
  const leftParts = left.split(/[.-]/).map(Number);
  const rightParts = right.split(/[.-]/).map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if ((leftParts[index] ?? 0) !== (rightParts[index] ?? 0)) {
      return (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    }
  }
  return 0;
};

const packages = fs.readdirSync(dist)
  .filter((name) => name.startsWith("downloadswift-") && name.endsWith(".zip"));
const removed = [];
const kept = new Map();
for (const name of packages) {
  const version = versionOf(name);
  // A package whose name the current tooling no longer produces (a past
  // naming scheme) is history the same way an old version is: removed.
  if (!version) {
    removed.push(name);
    continue;
  }
  kept.set(version, [...kept.get(version) ?? [], name]);
}

const versions = [...kept.keys()].sort(compareVersions).reverse();
for (const version of versions.slice(VERSIONS_TO_KEEP)) {
  removed.push(...kept.get(version));
}
for (const name of removed) {
  fs.unlinkSync(`${dist}/${name}`);
}
console.log(`kept: ${versions.slice(0, VERSIONS_TO_KEEP).join(", ")}`);
if (removed.length) console.log(`removed: ${removed.join(", ")}`);
