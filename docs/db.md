# Database cmds

## Backup/Restore

> [!NOTE]
> On Windows, PowerShell's `>` redirect saves files as UTF-16 which breaks PostgreSQL.
> Use the binary custom format (`-Fc`) + `pg_restore` to avoid encoding issues entirely.

### 1. Backup

> docker exec <container_name> pg_dump -U <user> -d <database> > backup.sql
> OR
> docker exec <container_name> pg_dump -U <user> -Fc -d <database> > backup.dump

### 2. Restore

Create database if not exist:

> docker exec -it <container_name> psql -U <user> -c "CREATE DATABASE <database>;"

Restore:

> docker exec -i <container_name> psql -U <user> -d <database> < backup.sql
> OR
> docker exec -i <container_name> pg_restore -U <user> -d <database> < backup.dump
