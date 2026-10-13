# Деплой Surf Birthday Route

Приложение — чистая статика (без бэкенда, без сборки). Публикация = «положить
папку на любой статик-хостинг». Ниже три готовых рецепта.

## Вариант 1. GitHub Pages (бесплатно, доступен из РФ)

Из этой папки (`surf-birthday/`):

```bash
git init -b main
git add -A
git commit -m "Surf Birthday Route"
gh repo create surf-birthday --public --source=. --push
gh api repos/{owner}/surf-birthday/pages -X POST -f "source[branch]=main" -f "source[path]=/"
```

(`{owner}` подставится сам, `gh` авторизован.) Через ~1 минуту сайт живёт на:

```
https://<твой-логин>.github.io/surf-birthday/
```

Обновления дальше: `git add -A && git commit -m ... && git push` — депloyится сам.

## Вариант 2. Cloudflare Pages (бесплатно, доступен из РФ)

1. Зайти на https://dash.cloudflare.com → Workers & Pages → Create → Pages.
2. Способ «Direct Upload»: перетащить папку `surf-birthday` (можно zip).
3. Получишь `https://surf-birthday-xxxx.pages.dev`, можно привязать свой домен.

Обновления: туда же перетащить новую версию папки.

## Вариант 3. Свой сервер (nginx)

Скопировать папку на сервер и отдавать nginx'ом. Готовый конфиг — в `deploy/nginx.conf`:

```bash
scp -r surf-birthday/ user@server:/var/www/
sudo cp surf-birthday/deploy/nginx.conf /etc/nginx/sites-available/surf-birthday
sudo ln -s /etc/nginx/sites-available/surf-birthday /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Или Docker одной командой (см. `deploy/Dockerfile`):

```bash
docker build -t surf-birthday deploy/
docker run -d -p 8080:80 --name surf-birthday surf-birthday
```

## Про нагрузку

Маршрутизация и геокодинг выполняются в браузере пользователя через публичные
OSRM/Nominatim — бесплатно и без ключей, но серверы общие. Для друзей и небольших
потоков хватает с запасом. Если сайт станет популярным — следующий шаг: свой
OSRM-инстанс (docker-образ `osrm/osrm-backend` + данные Москвы из Geofabrik) и
замена URL в `ROUTERS` в `app.js` на свой домен.
