import gulp from 'gulp'
import gulpif from 'gulpif'
import livereload from 'gulp-livereload'
import args from './util/args'

gulp.task('serve',(cb)=>{
  if(!args.watch) return cb()
    var server = liveserver.new(['--harmony','server/bin/www'])
    server.start()
    gulp.watch(['server/public/**/*.js','server/views/**/*.ejs'],function(file){
      server.notify.apply(server,[file])
    })
    gulp.watch(['server/routes/**/*.js','server/app.js'],function(file){
      server.start.bind(server)()
    })
})
