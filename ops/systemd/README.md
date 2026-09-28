# Monthly anime DB import on WalnutPi

The Release refresh runs on the 1st. This timer downloads the resulting
`db-v1` ZIP on the 2nd at 10:30 KST, validates the ZIP/SQLite file, and invokes
the existing PostgreSQL importer only when the Release asset has changed.
The import replaces catalog tables inside one transaction; it does not rebuild
or restart anime/caddy containers.

## One-time setup on the Pi

1. Update `~/streaming-project` to the merged main branch so the importer and
   updater script are present:

   ```bash
   cd ~/streaming-project
   git pull --ff-only
   ```

2. Create a fine-grained GitHub token restricted to the private
   `pingpingjinping/anime-db-download` repository with **Contents: read-only**.
   Store it in the service environment file; do not commit or paste the token
   into chat:

   ```bash
   mkdir -p ~/.config/streaming-project
   cp ops/systemd/anime-db.env.example ~/.config/streaming-project/anime-db.env
   nano ~/.config/streaming-project/anime-db.env
   chmod 600 ~/.config/streaming-project/anime-db.env
   ```

3. First run a download and integrity check without changing PostgreSQL:

   ```bash
   set -a
   . ~/.config/streaming-project/anime-db.env
   set +a
   python3 scripts/update-anime-db-release.py --dry-run
   ```

4. Install and enable the monthly timer:

   ```bash
   sudo install -m 644 ops/systemd/streaming-anime-db-update.service /etc/systemd/system/
   sudo install -m 644 ops/systemd/streaming-anime-db-update.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now streaming-anime-db-update.timer
   systemctl list-timers streaming-anime-db-update.timer
   ```

The service uses the DB Release asset digest to avoid re-importing an unchanged
asset. If a workflow fails on the 1st, the Pi service fails closed and retains
the current PostgreSQL catalog. Logs are available with:

```bash
journalctl -u streaming-anime-db-update.service
```
