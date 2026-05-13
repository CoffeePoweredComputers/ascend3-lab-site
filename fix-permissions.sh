#!/bin/bash
set -e

echo "=== Fixing nginx config and permissions ==="

# Update nginx config to use /var/www/ascend3
echo "Updating nginx config..."
sudo cp /home/dhsmith4/ascend3-lab-site/nginx-configs/ascend3.conf /etc/nginx/sites-available/
sudo nginx -t && sudo systemctl reload nginx
echo "Done."

# Reverse the chmod changes (restore private home directory)
echo "Restoring home directory permissions..."
chmod o-x /home/dhsmith4
chmod -R o-r /home/dhsmith4/ascend3-lab-site/dist
echo "Done."

echo ""
echo "=== Verifying site ==="
curl -sI https://ascend3.cs.vt.edu | head -3
