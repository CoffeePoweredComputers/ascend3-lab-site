#!/bin/bash
# Build and publish to the nginx web root.
#
# No sudo: /var/www/ascend3 is owned by the deploying user, so plain rsync
# works — and must, since autodeploy.sh runs this from cron, where sudo has
# no tty to prompt on.
set -e
npm run build
rsync -av --delete dist/ /var/www/ascend3/
