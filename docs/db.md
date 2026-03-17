# Database cmds

## Backup/Restore

### 1. Backup

> docker exec <container_name> pg_dump -U <user> -d <database> > backup.sql

### 2. Restore

Create database if not exist:

> docker exec -it <container_name> psql -U <user> -c "CREATE DATABASE <database>;"

Restore:

> docker exec -i <container_name> psql -U <user> -d <database> < backup.sql
