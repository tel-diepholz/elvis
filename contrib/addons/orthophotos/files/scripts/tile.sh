#!/bin/sh
# Erzeugt aus allen geladenen Dateien eine gemeinsame XYZ-Kachelpyramide (PNG, EPSG:3857).
set -eu
cd /data
find src -type f \( -iname '*.tif' -o -iname '*.tiff' -o -iname '*.jp2' \) > work-files.txt
[ -s work-files.txt ] || { echo 'Keine Quelldateien gefunden'; exit 1; }
gdalbuildvrt -addalpha -input_file_list work-files.txt work.vrt
gdalwarp -of VRT -t_srs EPSG:3857 -r bilinear work.vrt work-3857.vrt
rm -rf tiles.new
gdal2tiles.py --xyz --processes="${PROCESSES:-2}" -z "${MIN_ZOOM:-10}-${MAX_ZOOM:-19}" --webviewer=none work-3857.vrt tiles.new
# Erst nach erfolgreichem Lauf austauschen, damit die Karte nie halb leer ist
rm -rf tiles && mv tiles.new tiles
echo 'ELVIS_PROGRESS 100 fertig'
