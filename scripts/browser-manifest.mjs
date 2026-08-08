import fs from "node:fs";
import { pathToFileURL } from "node:url";

function backgroundPageManifest(source, removedPermissions) {
  const { minimum_chrome_version: _minimumChromeVersion, ...manifest } = source;
  return {
    ...manifest,
    permissions: manifest.permissions.filter((permission) => !removedPermissions.includes(permission)),
    background: { page: "background.html" }
  };
}

export function firefoxManifest(source) {
  return {
    ...backgroundPageManifest(source, ["downloads.ui", "offscreen"]),
    browser_specific_settings: {
      gecko: {
        data_collection_permissions: { required: ["websiteContent"] },
        id: "downloadswift@jxmtoma.github.io",
        strict_min_version: "142.0"
      }
    }
  };
}

export function safariManifest(source) {
  return {
    ...backgroundPageManifest(source, [
      "downloads",
      "downloads.open",
      "downloads.ui",
      "notifications",
      "offscreen"
    ]),
    icons: { ...source.icons, "512": "icon.svg" },
    // 26.0, not 17: every download writes its result through
    // FileSystemFileHandle.createWritable, which Safari only gained in 26.
    // Below that the writes are refused and the saved file is zero bytes.
    browser_specific_settings: { safari: { strict_min_version: "26.0" } }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, sourcePath, destinationPath] = process.argv.slice(2);
  const transform = { firefox: firefoxManifest, safari: safariManifest }[target];
  if (!transform || !sourcePath || !destinationPath) {
    throw new Error("Usage: browser-manifest.mjs firefox|safari SOURCE DESTINATION");
  }
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  fs.writeFileSync(destinationPath, `${JSON.stringify(transform(source), null, 2)}\n`);
}
