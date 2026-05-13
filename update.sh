#!/bin/bash
set -e
npm run build
sudo rsync -av --delete dist/ /var/www/ascend3/
