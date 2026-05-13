#!/bin/bash
set -e

echo "=== Fixing purplex proxy ==="

# Restart purplex container with new port (8443)
echo "Restarting purplex nginx container..."
cd /home/dhsmith4/purplex
docker rm -f purplex_nginx_1
docker-compose --profile production up -d nginx
echo "Done."

# Update host nginx config
echo "Updating host nginx config..."
sudo cp /home/dhsmith4/ascend3-lab-site/nginx-configs/purplex.conf /etc/nginx/sites-available/
sudo nginx -t && sudo systemctl reload nginx
echo "Done."

echo ""
echo "=== Verifying sites ==="
echo "ASCEND3: $(curl -sI https://ascend3.cs.vt.edu 2>&1 | head -1)"
echo "Purplex (direct): $(curl -sIk https://127.0.0.1:8443 2>&1 | head -1)"
