# Shao Lab Inventory

A search-and-report page for the lab's reagents. The page lives here and is served by GitHub Pages; the data lives in a Google Sheet and never in this repository.

- `index.html` is the page. Until it is connected it runs a demo with made-up sample data.
- `apps-script/Code.gs` is the script that lets the page read and write the Google Sheet. It contains no data and no passcodes.

**Do not commit the reagent list (`Seed.gs`) or any export of the Sheet here.** This repository is public, and the list includes where chemicals are stored.

## Connecting it to the Google Sheet

1. Open the inventory Google Sheet, then Extensions > Apps Script.
2. Replace the default code with `apps-script/Code.gs`. Add a second script file named `Seed` and paste in `Seed.gs` (kept outside this repository). Save.
3. Reload the Sheet. In the new "Lab inventory" menu choose "1. Set up tabs". Google asks you to authorize your own script the first time.
4. Choose "2. Set passcodes": one passcode that can edit, one that can only read.
5. In Apps Script: Deploy > New deployment > Web app. Execute as "Me", who has access "Anyone". Copy the web app address.
6. In `index.html`, replace `PASTE_WEB_APP_URL_HERE` with that address and commit.

The page then asks each person for their name and a passcode. The edit passcode can report stock, add items and edit vendor options; the read-only passcode can search, see the reorder list and export.

## Day to day

- The three tabs (Items, Vendor options, Stock events) can also be edited directly in the Sheet. To delete an item, delete its row there.
- Each item has a **Type**: Stocked (reordered when low), On hand (in the lab, never flagged), Asset (equipment), or Price only (a price on file, nothing bought). The page lists the first three by default. Price-only items appear when you press **Price list**, and the sizes that were hidden in the overseas price list appear under **More**.
- The same rule applies to `Merge.gs` (the one-time load of the merged inventory): it holds storage locations, so it stays out of this repository.
- After changing `Code.gs`, publish it with Deploy > Manage deployments > edit > New version. The web app address stays the same.
- To change a passcode, run "2. Set passcodes" again. Everyone signs in again with the new one.
