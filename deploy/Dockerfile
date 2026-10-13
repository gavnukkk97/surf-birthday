# Сборка из корня проекта (контекст = папка surf-birthday):
#   docker build -t surf-birthday -f deploy/Dockerfile .
#   docker run -d -p 8080:80 --name surf-birthday surf-birthday
FROM nginx:alpine
COPY . /usr/share/nginx/html/
EXPOSE 80
