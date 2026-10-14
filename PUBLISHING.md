# Publishing

## Release position

Video & Media Downloader saves direct HTTPS MP4/WebM/MOV/M4V files and
compatible on-demand HTTPS HLS and DASH streams locally. It supports HLS AES-128
with `KEYFORMAT="identity"`, separate fMP4 audio tracks, byte-range playlists,
subtitles saved as a WebVTT sidecar, and separate audio-only renditions. It does
not support insecure HTTP media, YouTube, DRM, other HLS encryption (including
SAMPLE-AES and non-identity key formats), encrypted DASH, live streams,
discontinuous byte-range HLS, separate TS audio/video tracks, paywall bypassing,
or access-control bypassing. DASH manifests with separate audio and video tracks
are merged into one movie.

Suggested short description:

> Save direct videos, compatible HLS (AES-128 included) and DASH locally: quality,
> subtitles, audio-only, MP4, no tracking.

Suggested listing introduction:

> Video & Media Downloader detects media on the page you choose and saves supported video
> files with local file processing. Direct files and compatible HLS
> and DASH streams download with progress, cancellation, sensible filenames,
> background continuation, quality selection, and clear completion status. HLS
> playlists with separate fMP4 audio tracks and DASH manifests with separate
> audio and video are merged into one MP4, subtitles save as a WebVTT sidecar
> next to the video, and an audio-only rendition can be saved on its own.

Required listing disclosure:

> Video & Media Downloader locally processes media URLs, page titles, and
> download status, plus limited request headers. Showing detected media may
> automatically fetch previews, quality options, and size estimates before you
> click Download. These HTTPS requests and downloads go to relevant site APIs
> and media/CDN hosts. Your browser may include permitted existing cookies, and
> the extension may replay Accept, Origin, Range, and Referer headers. The
> extension has no developer telemetry.

Use the **Tools** category. Do not list third-party site names or claim universal
compatibility. State clearly that users may download only media they have the
right to save.

## Browser release packages

Chrome and Microsoft Edge use the same ZIP. Microsoft lists every extension API
used here as supported in Edge MV3, including downloads, notifications,
offscreen documents, storage, declarative network rules, and `webRequest`.
Firefox uses the same source but needs its own ZIP because Firefox MV3 runs a
background page instead of a service worker and has no offscreen document or
`downloads.ui` API. Safari also uses the background-page package, but its manifest
omits the unsupported downloads and notifications APIs and uses Safari's native
file handoff. Do not create browser-specific source forks.

Build and check the upload package with the prerequisites and source-archive
steps in [Build from source in README.md](README.md#build-from-source):

```sh
node test-media.mjs && node test-hls.mjs && node test-dash.mjs && node test-mp4.mjs && node test-sites.mjs && node test-preview.mjs && node test-remux.mjs && node test-download-flow.mjs && node test-firefox.mjs && node test-safari.mjs && node test-presubmit.mjs
sh scripts/package.sh
npx --yes web-ext@10 lint --source-dir dist/firefox
```

The script produces `dist/downloadswift-<version>.zip` for Chrome and Edge and
browser-specific `dist/downloadswift-firefox-<version>.zip` and
`dist/downloadswift-safari-<version>.zip` packages. It also builds
`dist/downloadswift-firefox-source-<version>.zip` for AMO's source-code review,
and keeps only the current and the previous version's packages in `dist/`,
deleting older ones and artifacts left by past naming schemes. `dist/` is
untracked; the repository tags are the real release history.

Only `downloadswift-firefox-<version>.zip` goes to addons.mozilla.org as the
add-on file — it is the only package whose manifest carries the required
`browser_specific_settings.gecko.id`. The source package sits on the shared
repository tree, whose root manifest is the Chrome one without that ID, so
uploading it as the add-on fails AMO's "add-on ID is required in Manifest
Version 3" check. Attach the matching Firefox source package with every Firefox
version upload, separately from the add-on ZIP. Mozilla's source review
requirements apply because the packaging script generates the Firefox manifest.

Version 0.6.0 is publicly listed on Chrome Web Store and Mozilla Add-ons under
publisher `ylrbei.studio`. This tree prepares 0.7.0 as a candidate upload; verify
the current store dashboard status for 0.7.0 before uploading, since its pending
status has not been verified here. Treat dashboard state, rather than the
repository branch, as the record of submitted releases. While a store review is
pending, freeze that release's code except for reviewer-required fixes or
verified critical defects.
Safari remains supported and packaged, but its App Store publication is
deliberately on hold as described below.

Before claiming Edge support publicly, sideload the unpacked directory from
`edge://extensions` and complete the clean-profile test matrix below on the
current stable Edge release for macOS, Windows, and Linux.

## Apple App Store (Safari)

**Do not submit the Safari build yet.** The zero-byte save had two causes, both
now fixed: the sweep deleted the temporary file while Safari was still reading it,
and the save itself ran against a blob owned by the background page, which Safari
unloads. Saving now happens in its own tab. A synthetic save was verified byte-for-byte
on Safari 26.5.2, but a full real-world run (detect ▸ download ▸ save on a live
stream) has not been repeated since the change. See the Safari section of
[BROWSER-COMPAT.md](BROWSER-COMPAT.md). Clear this block once a real download
saves a non-zero, playable file.

The first Safari release is macOS-only and requires Safari 26 or later. Do not
select iOS, iPadOS, or visionOS for this build: Safari exposes the request
inspection needed here only on macOS, and the current save handoff is desktop-only.

### Test locally

1. Run the checks and package command above. See
   [Build from source](README.md#build-from-source) for prerequisites.
2. In **Safari → Settings → Advanced**, enable **Show features for web developers**.
3. In the **Developer** tab, choose **Add Temporary Extension** and select
   `dist/safari` or `dist/downloadswift-safari-<version>.zip`.
4. Enable the extension, grant access to the test site, and test direct MP4/WebM,
   TS-HLS, fMP4-HLS, cancellation, retry, ETA, source-tab closure, denied site
   access, HTTP rejection, Safari's file handoff, and all nine languages.

Safari removes temporary extensions after 24 hours or when Safari quits. Safari
exposes no WebExtension downloads or notifications API and honours a download
attribute only in an ordinary tab — from the background page it does nothing, and
from the popover it navigates instead of saving. So a finished job waits with a
**Save** button that opens the save tab, and the download happens there. Expect
Safari to ask "Do you want to allow downloads on <uuid>?" the first time: the
extension's UUID changes on every reload, so testers see this prompt after every
rebuild. Safari 26 is the minimum: every download writes its result through
`FileSystemFileHandle.createWritable`, which earlier releases lack, and without
it the saved file is zero bytes. Whether Safari's own save was accepted or
dismissed is not observable, so there is no completion notification or
open/show action.

### App Store Connect checklist

1. Enroll the publishing Apple Account in the Apple Developer Program.
2. Register and confirm the permanent app bundle ID
   `io.github.jxmtoma.downloadswift`. In App Store Connect, create a new macOS app
   named **Video & Media Downloader** with that ID and a private SKU such as
   `downloadswift-macos`. Use **Utilities** as the primary category.
3. Open the app's **Xcode Cloud** tab, choose **Safari Web Extension Packager →
   Upload**, and upload `dist/downloadswift-safari-<version>.zip`.
4. Complete the product, privacy, support, age-rating, rights, pricing, and
   availability fields. Select **Data Not Collected** for App Privacy: the app has
   no developer backend, analytics, advertising, or tracking.
5. Use TestFlight for a clean-profile Safari test, then attach the processed build
   to the macOS version and submit it for review.

Use the shared localized descriptions below. Suggested App Store keywords:
`video downloader,HLS,m3u8,MP4,media downloader,stream downloader`.

Use this reviewer note:

> This is a macOS Safari 26+ extension. No account is required. Open the MDN
> video element page, enable media detection, approve site access, play the
> flower video, then reopen the extension and download the detected file.
> Showing detected media can automatically fetch previews, quality options, and
> size estimates before Download. HTTPS requests and downloads go to relevant
> site APIs and media/CDN hosts; the browser may include permitted existing
> cookies, and the extension may replay Accept, Origin, Range, and Referer
> headers. The extension has no developer telemetry. Safari receives the
> prepared file through its native save flow, so this build intentionally
> requests no downloads or notifications permission. YouTube, DRM, other HLS
> encryption, encrypted DASH/live streams, and access-control bypassing are
> unsupported.

For a local Xcode wrapper instead of App Store Connect's web packager, run:

```sh
xcrun safari-web-extension-packager \
  --project-location dist/safari-app \
  --app-name "Video & Media Downloader" \
  --bundle-identifier io.github.jxmtoma.downloadswift \
  --swift --macos-only --copy-resources --no-open --no-prompt --force \
  dist/safari
```

Before archiving, confirm the app target uses
`io.github.jxmtoma.downloadswift` and the extension target uses
`io.github.jxmtoma.downloadswift.Extension`; Xcode rejects an embedded extension
whose bundle ID is not prefixed by its parent app ID.

Official references: [Safari Web Extension Packager](https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect),
[command-line packaging](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari),
and [temporary installation](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension).

## Store URLs and assets

- Product: `https://jxmtoma.github.io/downloadSwift/`
- Firefox Add-on: `https://addons.mozilla.org/addon/video-media-downloader/`
- Privacy: `https://jxmtoma.github.io/downloadSwift/privacy/`
- Support: `https://jxmtoma.github.io/downloadSwift/support/`
- Logo: `store-assets/icon-128.png`
- Firefox manifest icons: `icons/icon-32.png` and `icons/icon-64.png`
- Safari extension and generated app-icon source: `icon.svg` at manifest size 512
- Screenshots: `store-assets/screenshot-detected.png`,
  `store-assets/screenshot-downloading.png`, and
  `store-assets/screenshot-free.png`
- Small promotional tile: `store-assets/small-promo-440x280.png`
- Large promotional tile: `store-assets/marquee-1400x560.png`

## Firefox Add-ons

The public listing is [Video & Media Downloader on Mozilla Add-ons](https://addons.mozilla.org/addon/video-media-downloader/).
Version 0.6.0 is publicly listed on Chrome Web Store and Mozilla Add-ons under
publisher `ylrbei.studio`. This tree prepares 0.7.0 as a candidate upload; verify
the current store dashboard status for 0.7.0 before uploading, since its pending
status has not been verified here. Treat dashboard state, rather than the
repository branch, as the record of submitted releases. While a store review is
pending, freeze that release's code except for reviewer-required fixes or
verified critical defects.

### Account, test, and upload

1. Sign in to the Mozilla account for the existing add-on, open its Developer
   Hub page, and choose **Upload New Version**. Do not submit a new add-on.
2. Confirm the permanent add-on ID
   `downloadswift@jxmtoma.github.io` before the first submission. Updates must
   keep the same ID.
3. Run the checks above. In a clean current Firefox profile, temporarily load
   `dist/firefox/manifest.json` from `about:debugging#/runtime/this-firefox` and
   test direct MP4/WebM, TS-HLS, fMP4-HLS, cancel, retry, ETA, source-tab
   closure, notification click revealing the file in Downloads, denied site
   access, HTTP rejection, and all nine languages.
4. Upload `dist/downloadswift-firefox-<version>.zip`, select Firefox Desktop,
   and use **Download Management** plus **Photos, Music & Videos** as the two
   categories.
5. Use the shared short description above and the localized descriptions below.
   Add the product, privacy, support, icon, and screenshots listed above.

The Firefox manifest requires Firefox 140 or later and declares required
`websiteContent` data use. Explain that media URLs, page titles, download status,
and limited request headers are processed locally. Showing detected media may
automatically fetch previews, quality options, and size estimates before the
user clicks Download. HTTPS requests and downloads can go to relevant site APIs,
playlist/manifest URLs, and media/CDN hosts, including derived hosts. The browser
may include permitted existing cookies; the extension does not read or store
cookie values. The extension has no developer telemetry. In Firefox background-
page mode, its existing header replay rules omit tab and initiator restrictions,
so matching page or other requests may also receive replayed headers while the
rules are active.

Use these permission justifications:

- `activeTab`: read the selected tab ID and title and reload it after detection
  is enabled.
- Optional HTTPS site access and `webRequest`: detect media, capture limited
  request context, and fetch previews, quality options, and size estimates on
  sites the user enables.
- `declarativeNetRequestWithHostAccess`: replay limited request headers for
  related API, playlist, manifest, and media requests; in Firefox background-
  page mode, matching requests may include page or other requests because the
  existing rules omit tab and initiator restrictions.
- `downloads`: save and monitor the selected file, cancel it, and reveal it in
  Firefox Downloads after a notification click. `downloads.open` is deliberately
  not requested: Firefox allows it only from a user-action handler, which a
  notification click is not.
- `notifications`: notify the user when a selected download finishes.
- `storage`: keep detection results and job state in browser-session memory.

Firefox notifications do not expose Chrome-style action buttons, and a
notification click does not count as the user action `downloads.open` requires
([1523523](https://bugzilla.mozilla.org/show_bug.cgi?id=1523523)). Clicking the
Firefox completion notification therefore reveals the file in Firefox Downloads,
from where the user opens it.

Use this reviewer note:

> No account is required. Open the MDN video element page, enable detection,
> approve site access, play the flower video, then reopen the extension and
> download the detected file. Showing detected media can automatically fetch
> previews, quality options, and size estimates before Download. HTTPS requests
> and downloads go to relevant site APIs and media/CDN hosts; the browser may
> include permitted existing cookies, and the extension may replay Accept,
> Origin, Range, and Referer headers. The extension has no developer telemetry.
> The packaged third-party library is mux.js 6.3.0
> (`vendor/mux-mp4.min.js`), the official npm archive's
> `package/dist/mux-mp4.min.js` from
> https://registry.npmjs.org/mux.js/-/mux.js-6.3.0.tgz, SHA-256
> `2c01f04954bf67cfa0bf2294ff82e34df8f9749958a0fe5e5782e46f8be71e87`;
> readable source is at https://github.com/videojs/mux.js/tree/v6.3.0 and its
> Apache-2.0 license is included. YouTube, DRM, other HLS encryption, encrypted
> DASH/live streams, and access-control bypassing are intentionally unsupported.

Mozilla requires signing for release and beta Firefox builds.

### Source code submission is required with every version upload

AMO asks every submission whether it uses generators, minifiers, bundlers, or
"any other tool that takes code or files, applies processing, and generates code
or file(s) to include in the extension". **Answer yes.**
[`scripts/browser-manifest.mjs`](scripts/browser-manifest.mjs) generates the
`manifest.json` that ships inside the Firefox ZIP, so the uploaded manifest is
machine-generated rather than hand-written. Answering no because the tree is
otherwise readable is wrong and is the kind of thing a reviewer rejects over.

Run the packaging script from a clean source tree matching the candidate version
being uploaded. See [Build from source in README.md](README.md#build-from-source)
for prerequisites and fresh-archive setup. Build the add-on and source archives
from the same checkout:

```sh
sh scripts/package.sh
```

Upload the generated `dist/downloadswift-firefox-source-<version>.zip` as the AMO
source code package with every version upload, separately from
`dist/downloadswift-firefox-<version>.zip`. Never upload the source archive as the
add-on file itself (its Chrome-style root manifest has no add-on ID).

AMO requires the archive to carry step-by-step build instructions, a build
script, operating-system and build-environment requirements, and the required
versions and installation instructions of every program used. All four live in
the **Build from source** section of [README.md](README.md), which sits at the
archive root — point reviewers there rather than restating it in the notes. Keep
the mux.js release links in **Notes for Reviewers** regardless: the source upload
does not replace them, because `vendor/mux-mp4.min.js` is still unreadable inside
the archive.

Two builds of one source are byte-identical in content but not as ZIP bytes,
since zip records modification times. README.md tells reviewers to diff the
extracted trees rather than compare checksums.

Official references: [submission flow](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/),
[web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/),
[third-party libraries](https://extensionworkshop.com/documentation/publish/third-party-library-usage/),
and [Firefox data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).
See Mozilla's [source code submission requirements](https://extensionworkshop.com/documentation/publish/source-code-submission/)
and [third-party library policy](https://extensionworkshop.com/documentation/publish/third-party-library-usage/).

## Microsoft Edge Add-ons

### Account, test, and upload

1. Register an individual or company Microsoft Edge developer account in
   Partner Center using a Microsoft account as Primary Owner. Registration is
   free. Choose the account type and publisher name carefully; account type
   cannot be changed later.
2. Sideload the extension in a clean Edge profile and test direct MP4/WebM,
   TS-HLS, fMP4-HLS, cancel, retry, ETA, source-tab closure, both notification
   actions, denied site access, HTTP rejection, and every supported language.
3. In **Partner Center → Edge → Create new extension**, upload the exact
   `dist/downloadswift-<version>.zip` produced by `scripts/package.sh`.
4. Choose **Public** visibility and all markets, then select the **Tools**
   category. Enter the product, privacy, and support URLs above.

### Partner Center privacy answers

Single purpose:

> Detect supported media requested by a page the user chooses and save only the
> user-selected media locally to the user's device.

Data disclosure:

> The extension locally processes media URLs, page titles, download status, and
> limited request headers. Showing detected media may automatically fetch
> previews, quality options, and size estimates before the user clicks Download.
> These HTTPS requests and downloads go to relevant site APIs and media/CDN
> hosts. The browser may include permitted existing cookies, and the extension
> may replay Accept, Origin, Range, and Referer headers. The extension has no
> developer telemetry.

Select **No remote code**. `mux.js` and all executable code are packaged in the
ZIP; downloaded media and playlists are data, not executable code.

Use these permission justifications:

- `activeTab`: read the current tab ID and title when the user opens the popup,
  and reload that tab after the user enables detection.
- Optional HTTPS site access and `webRequest`: detect media, capture limited
  request context, and fetch previews, quality options, and size estimates on
  sites the user enables.
- `declarativeNetRequestWithHostAccess`: replay limited request headers for
  related API, playlist, manifest, and media requests. Browser rules may match
  the corresponding request hosts while active.
- `downloads`: save, monitor, cancel, and show user-selected downloads.
- `downloads.open`: open a completed file only after the user selects **Open
  file** in its completion notification.
- `downloads.ui`: suppress duplicate browser download UI during the managed file
  handoff, then restore it immediately.
- `notifications`: notify the user when a selected download finishes.
- `offscreen`: fetch, prepare, and transmux a selected download without opening
  another tab.
- `storage`: keep detection results and download state in browser-session memory.

## Localized store descriptions

Use these descriptions for Microsoft Edge Add-ons, Firefox, and Safari listings.

Each description below exceeds Edge's 250-character minimum.

#### English (`en`)

> Video & Media Downloader detects media requested by the page you choose and
> saves supported files locally. Download
> direct HTTPS MP4, WebM, MOV, and M4V files or compatible on-demand HLS
> (including AES-128) and DASH streams with progress, estimated completion time,
> cancellation, sensible filenames, background continuation, and clear completion
> status. HLS and DASH output is saved as MP4: separate audio tracks are merged
> into one movie, subtitles are saved as a WebVTT sidecar next to the video, an
> audio-only rendition can be saved on its own, and byte-range HLS playlists are
> supported. YouTube, DRM, unsupported HLS encryption, encrypted DASH, live
> streams, paywall bypassing, and access-control bypassing are not supported.
> Download only media you own or have permission to save.
>
> Video & Media Downloader locally processes media URLs, page titles, download
> status, and limited request headers. Showing detected media may automatically
> fetch previews, quality options, and size estimates before you click Download.
> These HTTPS requests and downloads go to the relevant site APIs and media/CDN
> hosts; the browser may include permitted existing cookies and replay Accept,
> Origin, Range, and Referer headers. The extension has no developer telemetry.

#### Español (`es`)

> Video & Media Downloader detecta el contenido multimedia solicitado por la
> página que elijas y guarda los archivos compatibles de forma local. Descarga
> archivos HTTPS directos
> en formatos MP4, WebM, MOV y M4V, así como transmisiones HLS y DASH compatibles
> bajo demanda, incluido HLS con AES-128. Muestra el progreso y el tiempo
> estimado restante, permite cancelar la descarga, crea nombres de archivo claros,
> continúa trabajando en segundo plano y muestra claramente el estado final. Las
> transmisiones HLS y DASH se guardan como MP4: las pistas de audio separadas se
> combinan en un solo archivo, los subtítulos se guardan como un archivo WebVTT
> junto al vídeo, una pista solo de audio puede guardarse por sí misma y se
> admiten listas HLS por rangos de bytes. No se admiten YouTube, DRM, otros
> cifrados HLS, DASH cifrado o transmisiones en directo, evasión de muros de pago
> ni de controles de acceso. Descarga únicamente contenido que poseas o que
> tengas permiso para guardar.
>
> Video & Media Downloader procesa localmente las URL de medios, los títulos de
> página, el estado de las descargas y un conjunto limitado de encabezados de
> solicitud. Al mostrar los medios detectados, puede obtener automáticamente
> vistas previas, opciones de calidad y estimaciones de tamaño antes de que
> pulses Descargar. Estas solicitudes HTTPS y descargas se dirigen a las API del
> sitio y a los hosts de medios/CDN pertinentes; el navegador puede incluir
> cookies existentes permitidas y volver a enviar los encabezados Accept, Origin,
> Range y Referer. La extensión no recopila telemetría para el desarrollador.

#### Français (`fr`)

> Video & Media Downloader détecte les médias demandés par la page que vous
> choisissez et enregistre localement les fichiers compatibles. Téléchargez des fichiers HTTPS
> directs aux formats MP4, WebM, MOV et M4V, ainsi que des flux HLS et DASH à la
> demande compatibles, dont HLS avec AES-128. L'extension affiche la progression
> et le temps restant estimé, permet d'annuler un téléchargement, crée des noms
> de fichiers clairs, poursuit les téléchargements en arrière-plan et affiche
> clairement l'état final. Les flux HLS et DASH sont enregistrés au format MP4 :
> les pistes audio séparées sont fusionnées en un seul fichier, les sous-titres
> sont enregistrés dans un fichier WebVTT à côté de la vidéo, une piste audio
> seule peut être enregistrée seule et les listes HLS par plages d'octets sont
> prises en charge. YouTube, les DRM, le chiffrement HLS autre que AES-128, le
> DASH chiffré ou les flux en direct, ainsi que le contournement des péages ou des
> contrôles d'accès ne sont pas pris en charge. Téléchargez uniquement les médias
> que vous possédez ou que vous êtes autorisé à enregistrer.
>
> Video & Media Downloader traite localement les URL des médias, les titres des
> pages, l’état des téléchargements et un ensemble limité d’en-têtes de requête.
> L’affichage des médias détectés peut récupérer automatiquement des aperçus,
> des options de qualité et des estimations de taille avant que vous cliquiez
> sur Télécharger. Ces requêtes HTTPS et téléchargements sont envoyés aux API
> du site et aux hôtes de médias/CDN concernés ; le navigateur peut inclure les
> cookies existants autorisés et renvoyer les en-têtes Accept, Origin, Range et
> Referer. L’extension ne collecte aucune télémétrie pour le développeur.

#### Deutsch (`de`)

> Video & Media Downloader erkennt Medien, die von der von Ihnen ausgewählten
> Seite angefordert werden, und speichert unterstützte Dateien lokal. Laden Sie
> direkte HTTPS-Dateien in den
> Formaten MP4, WebM, MOV und M4V sowie kompatible On-Demand-Streams über
> HLS (einschließlich AES-128) und DASH herunter. Die Erweiterung zeigt
> Fortschritt und geschätzte Restzeit an, ermöglicht das Abbrechen, erstellt verständliche
> Dateinamen, setzt Downloads im Hintergrund fort und zeigt den Abschlussstatus
> an. HLS- und DASH-Inhalte werden als MP4 gespeichert: getrennte Tonspuren
> werden zu einer Datei zusammengeführt, Untertitel werden als WebVTT-Datei
> neben dem Video gespeichert, eine Nur-Audio-Spur kann einzeln gespeichert
> werden und HLS mit Bytebereichen wird unterstützt. YouTube, DRM, weitere HLS-Verschlüsselung, verschlüsseltes DASH oder Live-Streams sowie das
> Umgehen von Paywalls oder Zugriffskontrollen werden nicht unterstützt. Laden
> Sie nur Medien herunter, die Ihnen gehören oder die Sie speichern dürfen.
>
> Video & Media Downloader verarbeitet Medien-URLs, Seitentitel, Downloadstatus
> und eine begrenzte Anzahl von Anfrage-Headern lokal. Beim Anzeigen erkannter
> Medien können automatisch Vorschauen, Qualitätsoptionen und Größenschätzungen
> abgerufen werden, bevor Sie auf „Herunterladen“ klicken. Diese HTTPS-Anfragen
> und Downloads gehen an die entsprechenden Website-APIs und Medien-/CDN-Hosts;
> der Browser kann zulässige vorhandene Cookies mitsenden und die Header Accept,
> Origin, Range und Referer erneut senden. Die Erweiterung erfasst keine
> Telemetriedaten für den Entwickler.

#### Português do Brasil (`pt_BR`)

> O Video & Media Downloader detecta a mídia solicitada pela página escolhida e
> salva localmente os arquivos compatíveis. Baixe arquivos HTTPS diretos nos formatos MP4, WebM,
> MOV e M4V, além de streams HLS e DASH sob demanda compatíveis, incluindo HLS
> com AES-128. A extensão mostra o progresso e o tempo restante estimado, permite
> cancelar o download, cria nomes de arquivo claros, continua os downloads em
> segundo plano e exibe claramente o estado final. O conteúdo HLS e DASH é salvo
> como MP4: faixas de áudio separadas são combinadas em um único arquivo,
> legendas são salvas como um arquivo WebVTT junto ao vídeo, uma faixa somente de
> áudio pode ser salva por si só e playlists HLS por intervalos de bytes são
> compatíveis. YouTube, DRM, outras criptografias HLS, DASH criptografado ou
> streams ao vivo, contorno de paywalls ou controles de acesso não são
> compatíveis. Baixe apenas mídias que você possui ou tem permissão para salvar.
>
> O Video & Media Downloader processa localmente URLs de mídia, títulos de páginas, status de downloads e um conjunto limitado de cabeçalhos de solicitação. A exibição de mídias detectadas pode buscar automaticamente prévias, opções de qualidade e estimativas de tamanho antes de você clicar em Baixar. Essas solicitações HTTPS e downloads são enviados às APIs relevantes do site e aos hosts de mídia/CDN; o navegador pode incluir cookies existentes permitidos e reenviar os cabeçalhos Accept, Origin, Range e Referer. A extensão não coleta telemetria para o desenvolvedor.

#### 日本語 (`ja`)

> Video & Media Downloader は、ユーザーが選択したページから要求されたメディアを検出し、対応するファイルをローカルに保存します。HTTPS 経由の MP4、WebM、MOV、M4V の直接動画ファイルと、AES-128 を含む対応オンデマンドの HLS および DASH ストリームをダウンロードできます。進行状況、完了までの推定時間、キャンセル、分かりやすいファイル名、バックグラウンドでの継続、完了状態の表示に対応しています。HLS と DASH は MP4 として保存され、分かれている音声トラックは 1 つのファイルに結合され、字幕は動画の横に WebVTT ファイルとして保存され、音声だけのトラックも単独で保存できます。バイトレンジ HLS にも対応しています。YouTube、DRM、非対応の HLS 暗号化、暗号化された DASH またはライブ配信のストリーム、ペイウォールやアクセス制御の回避には対応していません。自分が所有している、または保存する許可を得ているメディアだけをダウンロードしてください。
>
> Video & Media Downloader は、メディア URL、ページタイトル、ダウンロード状況、および限定されたリクエストヘッダーをローカルで処理します。検出されたメディアを表示すると、ダウンロードをクリックする前に、プレビュー、画質オプション、サイズの推定値が自動取得される場合があります。これらの HTTPS リクエストとダウンロードは、該当するサイトの API およびメディア/CDN ホストに送信されます。ブラウザーは、許可された既存の Cookie を含め、Accept、Origin、Range、Referer ヘッダーを再送信する場合があります。この拡張機能は開発者向けのテレメトリーを収集しません。

#### 한국어 (`ko`)

> Video & Media Downloader는 사용자가 선택한 페이지에서 요청하는 미디어를 감지하고, 지원되는 파일을 로컬에 저장합니다. HTTPS를 사용하는 MP4, WebM, MOV, M4V 직접 동영상 파일과 AES-128을 포함한 호환 주문형 HLS 및 DASH 스트림을 다운로드할 수 있습니다. 다운로드 진행률과 예상 남은 시간을 표시하고, 취소 기능과 알아보기 쉬운 파일 이름을 제공하며, 원본 탭을 닫은 뒤에도 백그라운드에서 계속 다운로드하고 완료 상태를 표시합니다. HLS와 DASH 콘텐츠는 MP4로 저장됩니다. 분리된 오디오 트랙은 하나의 파일로 병합되고, 자막은 동영상 옆에 WebVTT 파일로 저장되며, 오디오 전용 트랙도 따로 저장할 수 있습니다. 바이트 범위 HLS도 지원합니다. YouTube, DRM, 지원되지 않는 HLS 암호화, 암호화된 DASH 또는 라이브 스트림, 페이월 또는 접근 제어 우회는 지원하지 않습니다. 본인이 소유하거나 저장 권한이 있는 미디어만 다운로드하세요.
>
> Video & Media Downloader는 미디어 URL, 페이지 제목, 다운로드 상태 및 제한된 요청 헤더를 로컬에서 처리합니다. 감지된 미디어를 표시하면 다운로드를 클릭하기 전에 미리보기, 화질 옵션 및 크기 추정치를 자동으로 가져올 수 있습니다. 이러한 HTTPS 요청과 다운로드는 해당 사이트 API 및 미디어/CDN 호스트로 전송됩니다. 브라우저는 허용된 기존 쿠키를 포함하고 Accept, Origin, Range, Referer 헤더를 다시 전송할 수 있습니다. 확장 프로그램은 개발자용 텔레메트리를 수집하지 않습니다.

#### 简体中文 (`zh_CN`)

> Video & Media Downloader 可检测您所选择网页请求的媒体，并将受支持的文件保存到本地。您可以下载通过 HTTPS 提供的 MP4、WebM、MOV 和 M4V 直接视频文件，以及受支持的点播 HLS（包括 AES-128）和 DASH 流。扩展会显示下载进度和预计剩余时间，支持取消任务、生成清晰的文件名、在来源标签页关闭后继续后台下载，并清楚显示完成状态。HLS 和 DASH 内容会保存为 MP4；分开的音频轨会合并为一个文件，字幕会以 WebVTT 文件的形式保存在视频旁边，仅音频的轨道也可以单独保存，并且支持字节范围的 HLS。不支持 YouTube、DRM、不支持的 HLS 加密、加密 DASH、直播流，也不支持绕过付费墙或访问控制。请仅下载您拥有或已获得保存许可的媒体，并遵守相关网站条款和当地法律。
>
> Video & Media Downloader 会在本地处理媒体网址、页面标题、下载状态和有限的请求标头。显示检测到的媒体时，可能会在您点击“下载”之前自动获取预览、画质选项和大小估算值。这些 HTTPS 请求和下载会发送到相关的网站 API 及媒体/CDN 主机；浏览器可能会附带获准使用的现有 Cookie，并重新发送 Accept、Origin、Range 和 Referer 标头。此扩展不会收集供开发者使用的遥测数据。

#### 繁體中文 (`zh_TW`)

> Video & Media Downloader 可偵測您所選擇網頁要求的媒體，並將支援的檔案儲存到本機。您可以下載透過 HTTPS 提供的 MP4、WebM、MOV 和 M4V 直接影片檔案，以及受支援的隨選 HLS（包括 AES-128）和 DASH 串流。擴充功能會顯示下載進度和預估剩餘時間，支援取消工作、產生清楚的檔案名稱、在來源分頁關閉後繼續於背景下載，並清楚顯示完成狀態。HLS 和 DASH 內容會儲存為 MP4；分開的音訊軌會合併為單一檔案，字幕會以 WebVTT 檔案的形式儲存在影片旁邊，僅音訊的軌道也可以單獨儲存，並支援位元組範圍的 HLS。不支援 YouTube、DRM、不支援的 HLS 加密、加密 DASH、直播串流，也不支援繞過付費牆或存取控制。請僅下載您擁有或已取得儲存許可的媒體，並遵守相關網站條款及當地法律。
>
> Video & Media Downloader 會在本機處理媒體網址、頁面標題、下載狀態和有限的要求標頭。顯示偵測到的媒體時，可能會在您點選「下載」之前自動取得預覽、畫質選項和大小估算值。這些 HTTPS 要求和下載會傳送至相關網站 API 及媒體/CDN 主機；瀏覽器可能會附帶獲准使用的現有 Cookie，並重新傳送 Accept、Origin、Range 和 Referer 標頭。此擴充功能不會收集供開發者使用的遙測資料。

Search terms (seven or fewer per language, within Edge's 21-word and
30-character limits):

- `en`: `video downloader`, `HLS downloader`, `m3u8 downloader`, `MP4 downloader`, `streaming video downloader`, `media downloader`, `private video downloader`
- `es`: `descargador de videos`, `descargador HLS`, `descargador m3u8`, `descargador MP4`, `descargar videos online`, `descargador multimedia`, `descarga privada de videos`
- `fr`: `téléchargeur vidéo`, `téléchargeur HLS`, `téléchargeur m3u8`, `téléchargeur MP4`, `télécharger vidéo en ligne`, `téléchargeur multimédia`, `téléchargement vidéo privé`
- `de`: `Video Downloader`, `HLS Downloader`, `m3u8 Downloader`, `MP4 Downloader`, `Videos herunterladen`, `Streaming Video speichern`, `privater Video Download`
- `pt_BR`: `baixar vídeos`, `download de vídeos`, `baixador HLS`, `baixador m3u8`, `baixador MP4`, `baixar vídeo online`, `download privado de vídeo`
- `ja`: `動画ダウンローダー`, `動画ダウンロード`, `HLS ダウンローダー`, `m3u8 ダウンローダー`, `MP4 ダウンローダー`, `ストリーミング動画保存`, `動画保存 拡張機能`
- `ko`: `동영상 다운로더`, `동영상 다운로드`, `HLS 다운로더`, `m3u8 다운로더`, `MP4 다운로더`, `스트리밍 영상 저장`, `비공개 동영상 저장`
- `zh_CN`: `视频下载器`, `视频下载`, `HLS 下载器`, `m3u8 下载器`, `MP4 下载器`, `流媒体视频下载`, `私密视频下载`
- `zh_TW`: `影片下載器`, `影片下載`, `HLS 下載器`, `m3u8 下載器`, `MP4 下載器`, `串流影片下載`, `私密影片下載`

The package declares nine locales, so use the matching description above for
each Partner Center language row. Use Partner Center's **Duplicate** action for
the same logo, screenshots, and tiles.

## Microsoft Edge certification notes

> No account or credentials are required. Open the MDN `<video>` reference page
> at https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video.
> Open the extension, choose Enable media detection, approve site access, and
> allow the tab to reload. Play the flower video, reopen the extension, and
> download the detected MP4 or WebM. The popup shows progress and ETA. When the
> download finishes, its notification offers Open file and Show in folder.
> Showing detected media can automatically fetch previews, quality options, and
> size estimates before Download. HTTPS requests and downloads go to relevant
> site APIs and media/CDN hosts; the browser may include permitted existing
> cookies, and the extension may replay Accept, Origin, Range, and Referer
> headers. The extension has no developer telemetry. YouTube, DRM, other HLS
> encryption, encrypted DASH/live streams, and access-control bypassing are
> intentionally unsupported.

Submit after every locale row shows **Complete**. Microsoft says certification
can take up to seven business days.

Official references: [porting guide](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension),
[supported APIs](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support),
[developer registration](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account),
and [publishing flow](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension).

## Chrome Web Store

- Register the publisher, verify its email, enable 2-Step Verification, and pay
  the one-time Chrome Web Store developer fee.
- In repository **Settings → Pages**, choose **Deploy from a branch**, then
  publish `main` from `/docs`. Use these Developer Dashboard URLs:
  - Product: `https://jxmtoma.github.io/downloadSwift/`
  - Privacy: `https://jxmtoma.github.io/downloadSwift/privacy/`
  - Support: `https://jxmtoma.github.io/downloadSwift/support/`
  GitHub Pages sites are public. Keeping this source repository private requires
  GitHub Pro, Team, or Enterprise; on GitHub Free, publish `/docs` from a
  separate public site-only repository instead.
- In Privacy Practices, disclose handling of website content, media URLs, page
  titles, download status, limited request headers, and permitted existing
  cookies. State that showing detected media may automatically fetch previews,
  quality options, and size estimates before Download, with HTTPS requests to
  relevant site APIs and media/CDN hosts. State that the extension has no
  developer telemetry.
- Upload `store-assets/icon-128.png`, all three current 1280×800 screenshots, and
  `store-assets/small-promo-440x280.png`. The 1400×560 marquee is optional.
- Test the packed ZIP on clean Chrome profiles on macOS, Windows, and Linux:
  direct MP4/WebM, TS-HLS, fMP4-HLS, byte-range HLS, subtitle sidecar,
  audio-only, cancel, retry, source-tab closure,
  completion notification, denied site access, HTTP rejection, and each
  supported browser language.
- Upload first as **Private / trusted testers**, then move to public after the
  package and privacy declarations pass review.

## Monetization decision

Launch completely free and ad-free. Approval, reliability, reviews,
and support feedback are more valuable than early monetization.

Keep the current core free forever:

- Direct-file and supported HLS downloads
- MP4 output, filenames, progress, cancellation, and notifications
- Session download history

If Premium is reconsidered, add it only when several advanced features exist:

- Quality/variant selection and batch queues
- DASH and separate audio/video merging
- Subtitle/audio extraction and live recording
- Persistent history, filename templates, and per-site folders

Do not embed a generic advertising SDK. Manifest V3 disallows remotely hosted
JavaScript, and Chrome Web Store policy prohibits using browsing activity for
personalized advertising. If advertising is added later, use a clearly labeled,
non-personalized direct sponsor card with packaged creative and a user-clicked
destination link. Disclose it in the listing, UI, and privacy policy. A real
sponsor image and destination URL are required before adding that surface.

## Maintenance

For each release: update `manifest.json` version, update `CHANGELOG.md`, run all
checks, inspect the ZIP contents, test the unpacked release on a clean profile,
commit, tag `v<version>`, then upload the exact ZIP produced from that commit.
Review Chrome Web Store, Microsoft Edge Add-ons, Mozilla Add-on policies, and
mux.js updates before each feature release.
