# Database cmds

## Backup/Restore

> [!NOTE]
> On Windows, PowerShell's `>` redirect saves files as UTF-16 which breaks PostgreSQL.
> Use the binary custom format (`-Fc`) + `pg_restore` to avoid encoding issues entirely.

### 1. Backup

> docker exec <container_name> pg_dump -U <user> -d <database> > backup.sql
> OR
> docker exec <container_name> pg_dump -U <user> -Fc -d <database> > backup.dump
> OR
> docker exec <container_name> pg_dump -U <user> -Fc -d <database> -f /tmp/backup.dump

#### 1.1 Copy out of the container to your host (binary-safe):

> docker cp <container_name>:/tmp/backup.dump ./backup.dump

### 2. Restore

Create database if not exist:

> docker exec -it <container_name> psql -U <user> -c "CREATE DATABASE <database>;"

Copy bak file into container:

> docker cp /tmp/backup.dump <container_name>:/tmp/backup.dump

Restore:

> docker exec -i <container_name> psql -U <user> -d <database> < backup.sql
> OR
> docker exec -i <container_name> pg_restore -U <user> -d <database> < backup.dump
> OR
> docker exec <container_name> pg_restore -U <user> -d <database> -f /tmp/backup.dump
