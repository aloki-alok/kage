import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heldCommand } from '../held.ts'

// ADR 0018's stress corpus: every one-way step held, no everyday step held.
const ONE_WAY = [
  'rm -rf build', 'rm -r ~/notes', 'cd /srv && rm -f app.log', 'sudo rm -rf /var/www',
  'git push --force origin feat', 'git push -f', 'git push origin main', 'git push origin HEAD:production', 'git push origin --delete feat', 'git reset --hard HEAD~3', 'git branch -D old',
  'gh pr merge 12 --squash', 'gh release create v1.2.0', 'gh api -X DELETE repos/a/b', 'gh secret set TOKEN',
  'kubectl apply -f deploy.yaml', 'kubectl rollout restart deploy/api', 'helm upgrade api ./chart',
  'docker push me/app:1', 'docker compose down', 'docker rm -f web', 'docker compose up -d',
  'systemctl restart nginx', 'ssh prod "sudo systemctl restart odoo"', "ssh prod 'docker restart api'",
  'terraform apply -auto-approve', 'aws ec2 terminate-instances --instance-ids i-1', 'aws s3 rm s3://b/k', 'aws ecs update-service --force-new-deployment',
  'npm publish', 'wrangler deploy', 'fly deploy',
  'psql -c "delete from leads where id = 4"', "ssh prod psql -c 'UPDATE res_users SET active = false'", 'sqlite3 kage.db "drop table x"', 'redis-cli flushall',
  'curl -X POST https://api.example.com/v1/send', 'curl -d @body.json https://hooks.example.com/x', 'curl --data-urlencode a=b https://x.y', 'curl -XDELETE https://x.y/1',
  'sendmail someone@example.com < note.txt', 'pkill -f worker', 'kill -9 4242', 'reboot',
  'stripe subscriptions cancel sub_1', 'chmod -R 777 /srv', 'echo x > /etc/hosts', 'crontab -r',
  'bash -c "git push --force"', 'git -C repo push --force origin feat', 'git -C /srv/app reset --hard', 'gh -R a/b pr merge 1',
  'kubectl --context prod apply -f x.yaml', 'docker -H ssh://box rm -f web', 'docker compose -f prod.yml down', 'aws --profile p s3 rm s3://b/k', 'aws s3 --region us-east-1 rm s3://b/k', 'python3 -c "import os; os.system(\'rm -rf /\')"',
  '/bin/rm -rf x', 'xargs rm -rf', 'curl -sX POST https://x.y', 'curl -sd x https://x.y', 'git push origin +main', 'git push origin refs/heads/main',
  'find . -delete', 'find . -name "*.log" -exec rm {} +', 'ssh prod rm -rf /srv/app', 'gh api graphql -f query="mutation { deleteRepo }"',
  'git push origin "main"', 'git push origin "+main"', 'git push origin HEAD:"main"', 'git push -fu origin x', 'git push -uf origin x', 'git push --mirror',
  'ssh -i k host rm -rf x', 'ssh -p 22 host rm -rf x', '\\rm -rf x', 'busybox rm -rf x', 'curl -X"POST" https://x.y', 'curl --request=POST https://x.y', 'curl -sdx https://x.y',
  'gh api /repos/a/b --method=DELETE', 'gh api graphql -F query=@f.graphql', 'echo "delete from t" | psql', 'psql -f change.sql', 'rsync -a --delete src/ host:dst/',
  'gh workflow run deploy.yml', 'git stash drop', 'xargs -n 1 rm -rf', 'env A=1 rm -rf x', 'timeout 5 rm -rf x', 'tee /etc/hosts', 'echo x >/etc/hosts',
  'for f in *.tmp; do rm -rf "$f"; done', 'if [ -d x ]; then rm -rf x; fi', '{ rm -rf x; }', 'while read l; do kill -9 $l; done < pids', '! rm -rf x',
  'TOKEN="$(curl -sX POST https://x.y/login)"', 'x="$(git push -f)"', 'docker compose exec -T db psql -U x -c "DELETE FROM t"', "docker exec c sh -c 'rm -rf /data'",
  "kubectl exec p -- psql -c 'delete from t'", 'docker-compose down', 'docker stack deploy -c x.yml app', 'kubectl \\\n  apply -f x.yaml', 'git \\\n push -f',
  'aws cloudformation deploy --stack-name s', 'aws s3 rb s3://b', 'gcloud run deploy api', 'gsutil rm -r gs://b', 'az group delete -n x', 'heroku restart', 'cdk deploy',
  'ansible-playbook site.yml', 'wrangler pages deploy dist', 'fly apps destroy x', 'alembic upgrade head', 'prisma migrate deploy', 'python manage.py migrate',
  'supabase db push', 'dropdb x', "mongosh --eval 'db.x.deleteMany({})'", 'redis-cli incr k', 'npm -w x publish', 'pnpm --filter x publish', 'npx changeset publish',
  'twine upload dist/*', 'terraform -chdir infra apply', 'terraform state rm x', 'cp nginx.conf /etc/nginx/nginx.conf', "sed -i 's/a/b/' /etc/hosts", 'echo x > /opt/x',
  'echo x >| /etc/hosts', "python3 -c \"import requests; requests.post('http://x.y')\"", 'http POST https://x.y', 'wget --method POST https://x.y',
  'ssh host -- rm -rf x', 'ssh prod bash < migrate.sh', "node -e \"require('fs').rmSync('x',{recursive:true})\"", 'git checkout .', 'git branch -fd x',
  'bash <<EOF\nrm -rf /srv\nEOF', 'psql <<EOF\ndelete from t;\nEOF', 'vercel --prod',
]
const TWO_WAY = [
  'ls -la', 'cat README.md', 'grep -rn TODO src', 'git status', 'git log --oneline -5', 'git diff main', 'git commit -m "fix: x"', 'git push origin feat/x', 'git push -u origin fix-123',
  'gh pr create --fill', 'gh pr view 12', 'gh api repos/a/b/pulls', 'npm test', 'node script.ts', 'mkdir -p out', 'rm /tmp/scratch.txt', 'rm out/old.csv',
  '~/scripts/prodsql "select count(*) from leads"', 'psql -c "select * from leads limit 5"', 'ssh prod "tail -n 50 /var/log/odoo.log"', 'sqlite3 -readonly kage.db "select id from schedules"',
  'curl -s https://api.example.com/v1/status', 'curl -sI https://example.com', 'wget -q https://example.com/data.csv', 'docker ps', 'docker logs api --tail 20', 'kubectl get pods',
  'aws s3 ls s3://bucket', 'git -C repo push origin feat', 'git -C repo status', 'kubectl --context prod get pods', 'aws --profile p s3 ls s3://b', 'aws ecs describe-services --cluster c', 'terraform plan', 'cat mail.txt', 'echo skill', 'python3 report.py', 'jq .items data.json', 'systemctl status nginx',
  'grep -rn "kill " .', 'git commit -m "fix reboot loop"', 'git commit -m "kill switch for rm -r docs"', 'git push origin fix/release', 'gh api graphql -f query="{ viewer { login } }"', 'find . -name "*.ts"',
  'git commit -m "reboot the thing"', "git commit -m 'rm -rf is bad'", 'git commit -m "sudo docs"', 'git commit -m "kill -9 1"', 'git commit -m "git push -f"', 'gh pr create -b "rm -rf"',
  'grep -r "rm -rf" .', 'git log --grep="rm -rf"', 'echo "sudo is a word"', 'kill -0 1', 'pkill -0 worker', 'echo x > /var/tmp/x', 'psql -c "select * from t where x = \'copy\'"', 'git restore --staged a.ts',
  "cat > docs/x.md <<'EOF'\nsudo rm -rf /\nEOF", "cat <<'EOF' > notes.md\nkubectl apply -f x\nEOF", "git commit -F - <<EOF\nkill the flaky test\nreboot docs\nEOF",
  "psql -h db-copy.internal -c 'select 1'", "psql -d prod-copy -c 'select 1'", "psql -U update -c 'select 1'", "mysql -h update.example.com -e 'select 1'",
  'psql -c "copy (select 1) to stdout"', "mysql -e 'show create table t'", "psql -c 'select * from t -- drop later'", "sqlite3 kage.db 'select * from t where a=\"update\"'",
  "python3 -c \"print('sudo rm -rf')\"", "node -e \"console.log('rm -rf x')\"", 'git push --dry-run origin main', 'git push -n origin main', 'command -v sudo', 'ls # a; rm -rf x',
  'redis-cli get k', 'redis-cli config get maxmemory', 'docker compose ps', 'docker exec c ls /data', "kubectl exec p -- ls", 'gcloud run services list', 'az group list',
  'http https://x.y/status', 'cat /etc/hosts', 'cp /etc/hosts ./hosts', 'ssh prod bash -c "uptime"', 'ssh host -- ls',
]

test('every one-way shell step is held, with a reason', () => {
  for (const c of ONE_WAY) assert.ok(heldCommand(c), c)
})
test('no everyday shell step is held', () => {
  for (const c of TWO_WAY) assert.equal(heldCommand(c), undefined, c)
})
test('a long line is checked at once, never backtracked for seconds', () => {
  for (const line of ['aws' + ' --a b'.repeat(20_000) + ' q', 'aws --a --b ec2' + ' --a b'.repeat(20_000), ' curl'.repeat(20_000), ' psql'.repeat(20_000), ' find'.repeat(20_000), 'git' + ' --a b'.repeat(20_000), '"'.repeat(20_000), 'ssh h '.repeat(5_000) + 'ls']) {
    const t = performance.now()
    heldCommand(line)
    assert.ok(performance.now() - t < 1500, line.slice(0, 30))   // linear: about 30 ms alone; the old regex never finished
  }
})

