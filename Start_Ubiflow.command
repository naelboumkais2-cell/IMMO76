#!/bin/bash
echo "====================================="
echo "Démarrage du Serveur Ubiflow Auto-API"
echo "====================================="
cd "/Users/naelboumkais/Desktop/Nira/IMMO76/Ubiflow-Auto-API"

# On utilise la version de Node intégrée et auto-contenue que je viens de télécharger
./node-v20.11.1-darwin-arm64/bin/node server.js
