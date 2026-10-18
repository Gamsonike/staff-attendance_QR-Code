# Staff Attendance Server (single server)

Node.js + SQLite. All checks (rotating code, location, one sign-in/out per day, PIN verification, login lockout) run on the server.

## Install (Ubuntu, as an example)
```bash
sudo apt install -y nodejs npm            # Node 18+ required (use NodeSource if your distro is older)
sudo mkdir -p /opt/attendance && sudo chown $USER /opt/attendance
cp -r server.js package.json public README.md /opt/attendance && cd /opt/attendance
npm install --omit=dev
APP_URL=https://attendance.yourcompany.com TZ_NAME=Africa/Accra node server.js
```
Open the site and complete the first-time setup (this creates the admin).

## Settings (environment variables)
| Variable | Default | Meaning |
|---|---|---|
| PORT | 3000 | Port the app listens on |
| TZ_NAME | Africa/Accra | Time zone used for "today" and displayed times |
| DB_FILE | ./attendance.db | SQLite file location |
| APP_URL | (request host) | Public address placed in the QR code |

## HTTPS is mandatory
Phone browsers only allow the location check over HTTPS. Easiest option is Caddy as a reverse proxy (automatic certificates):
```
attendance.yourcompany.com {
    reverse_proxy localhost:3000
}
```

## Keep it running (systemd) - /etc/systemd/system/attendance.service
```
[Unit]
Description=Attendance
After=network.target
[Service]
WorkingDirectory=/opt/attendance
Environment=APP_URL=https://attendance.yourcompany.com TZ_NAME=Africa/Accra
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data
[Install]
WantedBy=multi-user.target
```
Then: `sudo systemctl enable --now attendance` (make /opt/attendance writable by that user).

## Backups
Copy `attendance.db` nightly, e.g. `sqlite3 attendance.db ".backup /backups/att-$(date +%F).db"`.

## Notes
- Entrance screen: open **Entrance QR** as an admin on a tablet and leave it on (the QR rotates every 45 s).
- Location coordinates come from the phone, so a determined person could spoof them. The rotating code is the main safeguard.
- Removing a staff member deactivates them; their history is kept. Admin edits are written to the `audit` table.
