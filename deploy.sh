#!/bin/bash
set -e

echo "=== ASCEND3 Deployment Script ==="
echo ""

# Step 1: Copy nginx configs and enable sites
echo "Step 1: Setting up nginx site configs..."
sudo cp /home/dhsmith4/ascend3-lab-site/nginx-configs/ascend3.conf /etc/nginx/sites-available/
sudo cp /home/dhsmith4/ascend3-lab-site/nginx-configs/purplex.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/ascend3.conf /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/purplex.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
echo "Done."
echo ""

# Step 2: Stop purplex nginx to free ports 80/443
echo "Step 2: Stopping purplex nginx container..."
cd /home/dhsmith4/purplex && docker-compose --profile production stop nginx
echo "Done."
echo ""

# Step 3: Start host nginx
echo "Step 3: Testing and starting host nginx..."
sudo nginx -t
sudo systemctl start nginx
echo "Done."
echo ""

# Step 4: Get SSL certs
echo "Step 4: Obtaining SSL certificates..."
sudo certbot --nginx -d ascend3.cs.vt.edu --non-interactive --agree-tos -m dhsmith4@vt.edu
sudo certbot --nginx -d purplex.org -d www.purplex.org --non-interactive --agree-tos -m dhsmith4@vt.edu
echo "Done."
echo ""

# Step 5: Restart purplex with new port
echo "Step 5: Restarting purplex container with new port..."
cd /home/dhsmith4/purplex && docker-compose --profile production up -d nginx
echo "Done."
echo ""

echo "=== Deployment Complete ==="
echo ""
echo "Verifying sites..."
echo "ASCEND3: $(curl -sI https://ascend3.cs.vt.edu 2>/dev/null | head -1 || echo 'Could not connect')"
echo "Purplex: $(curl -sI https://purplex.org 2>/dev/null | head -1 || echo 'Could not connect')"
