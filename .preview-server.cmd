@echo off
rem 本地静态预览服务（分离进程启动，便于长期访问）
rem 绑定 0.0.0.0，这样本机 127.0.0.1 与同一局域网都能访问
cd /d H:\site-publish
python -m http.server 8080 --bind 0.0.0.0
