# Releasing Ployd

The release workflow (`.github/workflows/release.yml`) signs the macOS app with the
ANP Labs Developer ID and sends it to Apple for notarization. Notarization is an
automated malware scan by Apple. A notarized app opens with no Gatekeeper warning.
The Windows installer is not signed.

These values identify the app and the team:

| Item | Value |
|---|---|
| Bundle id | `io.anplabs.ployd` |
| Apple team | ANP DESENVOLVIMENTO DE SOFTWARE LTDA |
| Team ID | `Y87W583VKZ` |
| Signing identity | `Developer ID Application: ANP DESENVOLVIMENTO DE SOFTWARE LTDA (Y87W583VKZ)` |

`package.json` pins the signing identity to this team, so a build never signs with a
personal certificate by mistake. You do not register the bundle id in the Apple
Developer portal. Developer ID signing and notarization do not use an App ID.

You do the setup below once. After that, each release is a version bump and a
published GitHub Release.

## What you need

- Membership in the ANP Labs team of the Apple Developer Program.
- The Account Holder role on that team, or help from the Account Holder. Only that
  role can create a Developer ID certificate.
- The Admin role in App Store Connect, to create the API key.
- Admin access to the `anplabs/ployd` repository on GitHub.
- The `gh` CLI, logged in with `gh auth login`.

## 1. Create the Developer ID Application certificate

The workflow signs with a certificate of type "Developer ID Application". An
"Apple Development" certificate does not work for apps that you distribute outside
the App Store. Use one of the two methods below.

### Method A: Xcode

1. Open Xcode and go to Settings > Accounts.
2. Select your Apple ID, then select the team ANP DESENVOLVIMENTO DE SOFTWARE LTDA.
3. Click Manage Certificates.
4. Click the plus button and select Developer ID Application.

Xcode makes the private key, sends the request to Apple, and installs the
certificate in your login keychain.

### Method B: the Apple Developer website

1. Open Keychain Access.
2. Select Keychain Access > Certificate Assistant > Request a Certificate From a
   Certificate Authority.
3. Type your email address and the common name `ANP Labs Developer ID`.
4. Select Saved to disk, and save the `.certSigningRequest` file.
5. Go to developer.apple.com > Account > Certificates, IDs & Profiles > Certificates.
6. Make sure that the team selector at the top shows ANP DESENVOLVIMENTO DE SOFTWARE LTDA.
7. Click the plus button, select Developer ID Application, and select the G2 Sub-CA.
8. Upload the `.certSigningRequest` file and download the `.cer` file.
9. Double-click the `.cer` file to install it in your login keychain.

### Make sure that the certificate is installed

Run this command:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

The output must show this line:

```
Developer ID Application: ANP DESENVOLVIMENTO DE SOFTWARE LTDA (Y87W583VKZ)
```

If the line is not there, the private key is not in your keychain. Do method A or B
again on the Mac that made the request.

## 2. Export the certificate as a .p12 file

1. Open Keychain Access and select the login keychain, then the My Certificates tab.
2. Find "Developer ID Application: ANP DESENVOLVIMENTO DE SOFTWARE LTDA".
3. Expand it, and select the certificate and its private key together.
4. Right-click and select Export 2 items. Save it as `ployd-developer-id.p12`.
5. Set a strong export password. The workflow needs this password.

Keep the .p12 file out of the repository. It contains the private key.

## 3. Create an App Store Connect API key

The workflow uses this key to send the app to the notarization service.

1. Go to appstoreconnect.apple.com > Users and Access > Integrations > App Store
   Connect API.
2. If Apple asks, request access to the API first.
3. Under Team Keys, click the plus button. Name the key `Ployd notarization` and
   give it the Developer role.
4. Download the `AuthKey_<KEY ID>.p8` file. Apple lets you download it one time only.
5. Write down the Key ID from the table, and the Issuer ID from the top of the page.

## 4. Add the GitHub secrets

Run these commands from the repository root. Each `gh secret set` command without a
file asks for the value, so the value does not go into your shell history.

```bash
base64 -i ployd-developer-id.p12 | gh secret set MAC_CERT_P12_BASE64 -R anplabs/ployd
gh secret set MAC_CERT_PASSWORD -R anplabs/ployd          # paste the .p12 password
gh secret set APPLE_API_KEY_P8 -R anplabs/ployd < AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_API_KEY_ID -R anplabs/ployd           # paste the Key ID
gh secret set APPLE_API_ISSUER -R anplabs/ployd           # paste the Issuer ID
```

To see that all five secrets are set, run `gh secret list -R anplabs/ployd`.

If you set only some of the notarization secrets, the macOS build fails. If you set
none of the secrets, the workflow builds an ad-hoc signed app that is not notarized.

After you add the secrets, move the .p12 and .p8 files to a password manager and
delete the local copies.

## 5. Test the setup

Run the workflow by hand, with no release:

```bash
gh workflow run release.yml -R anplabs/ployd --ref main
gh run watch -R anplabs/ployd
```

The macOS job runs `codesign`, `stapler validate` and `spctl` on each app after the
build. If one of them fails, the job fails. Notarization usually takes 2 to 10 minutes.

## Cut a release

1. Bump `version` in `package.json` and merge it to `main`.
2. Tag the commit, for example `v0.19.0`, and push the tag.
3. Publish a GitHub Release for that tag.

The workflow attaches the `.dmg`, `.zip`, `.exe` and `latest*.yml` files to the
release. Installed apps read `latest-mac.yml` to find updates.

## Sign a build on your own Mac

If the Developer ID certificate is in your keychain, `npm run dist:mac` signs with it.
To notarize the local build too, set these environment variables before you run it:

```bash
export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
npm run dist:mac
```

If you do not have the certificate, use `npm run dist:mac:unsigned`. That command
makes an ad-hoc signed app that runs on your Mac.

## The first signed release

The first signed release also changes the bundle id from `com.pauloperego.ployd` to
`io.anplabs.ployd`. These are the effects for users who already have Ployd:

- macOS does not let an ad-hoc signed app replace itself with a Developer ID signed
  app. These users see a "download manually" link in place of "Relaunch to update".
  They download the new `.dmg` one time. After that, updates install automatically.
- The board, the task logs and the worktrees stay. Ployd keeps its data folder by app
  name, and the name did not change.
- macOS asks again for the notification permission, because it keeps that
  permission by bundle id.
- On Windows, the installer upgrades the old install in place. `nsis.guid` in
  `package.json` keeps the old uninstall GUID. Do not change it.
