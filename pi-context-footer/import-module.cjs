// Native Node module evaluation gives import() its host loader callback.
module.exports = (url) => import(url);
