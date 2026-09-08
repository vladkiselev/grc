# Car Rental Polygon Search

Интерактивная карта: рисуете полигон, инструмент запрашивает [Overpass API](https://overpass-api.de)
(данные OpenStreetMap) и находит все объекты `amenity=car_rental` / `shop=car_rental` внутри
нарисованной области. Результат — список + маркеры на карте + экспорт в CSV.

Полностью статический сайт (один HTML-файл, без бэкенда) — работает и бесплатно на любом
статическом хостинге (GitHub Pages, Render Static Site, Netlify, Vercel и т.д.).

## Стек
- [Leaflet](https://leafletjs.com/) — карта
- [Leaflet.draw](https://github.com/Leaflet/Leaflet.draw) — рисование полигона
- Overpass API — источник данных (OSM), бесплатно, без ключей

## Локальный запуск
Просто откройте `index.html` в браузере — внешних зависимостей, кроме CDN-скриптов, нет.

## Деплой на Render (Static Site)
1. Запушить репозиторий на GitHub.
2. В Render: New → Static Site → подключить репозиторий.
3. Publish directory: `.` (корень репо, там лежит `index.html`).
4. Build command: не требуется (пусто).
