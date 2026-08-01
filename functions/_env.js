// 本文件由 deploy.sh 在打包时覆写，用于区分 dev 与 prod 的数据隔离。
// 仓库里保留的默认值是 dev —— 本地 `wrangler pages dev` 直接可用，
// 且万一部署脚本没跑到这一步，写入的也是 dev 桶，不会污染正式站。
export const APP_ENV = 'dev';
