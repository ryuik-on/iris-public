"""Write through directory descriptors; never follow any path component's link."""
import errno
import json
import os
import secrets
import stat
import sys

payload = json.load(sys.stdin)
target = payload['path']
mode = payload['mode']
content = payload['content'].encode('utf-8')
if not target.startswith('/') or len(content) > 1024 * 1024:
    raise ValueError('invalid write')
parts = target.split('/')[1:]
if not parts or any(p in ('', '.', '..') for p in parts):
    raise ValueError('invalid path')
directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
temp = None
try:
    for part in parts[:-1]:
        try:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
        except FileNotFoundError:
            try:
                os.mkdir(part, 0o700, dir_fd=directory)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
        os.close(directory)
        directory = child
    name = parts[-1]
    try:
        before = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        before = None
    if before and not stat.S_ISREG(before.st_mode):
        raise ValueError('リンクや通常ファイル以外には書き込めません。')
    if mode == 'create_only' and before:
        raise FileExistsError('ファイルは既に存在します。')
    temp = '.iris-write-' + secrets.token_hex(16)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    with os.fdopen(fd, 'wb') as stream:
        if mode == 'append' and before:
            old = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            with os.fdopen(old, 'rb') as source:
                opened = os.fstat(source.fileno())
                if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                    raise ValueError('書き込みの前にファイルが変わりました。')
                if opened.st_size > 16 * 1024 * 1024:
                    raise ValueError('追記するファイルが大きすぎます（上限16MB）。')
                copied = 0
                while True:
                    chunk = source.read(65536)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > 16 * 1024 * 1024:
                        raise ValueError('追記中に元のファイルが上限を超えました。')
                    stream.write(chunk)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
        size = stream.tell()
    if mode == 'create_only' or (mode == 'append' and before is None):
        os.link(temp, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
        os.unlink(temp, dir_fd=directory)
    else:
        os.rename(temp, name, src_dir_fd=directory, dst_dir_fd=directory)
    temp = None
    print(json.dumps({'created': before is None, 'size': size}))
finally:
    if temp:
        os.unlink(temp, dir_fd=directory)
    os.close(directory)
