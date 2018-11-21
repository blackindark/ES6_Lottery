import gulp from 'gulp'
import gulpif from 'gulpif'
import livereload from 'gulp-livereload'
import args from './util/args'

gulp.task('pages',()=>{
  return gulp.src('app/**/*.ejs')
    .pipe(gulp.dest('server'))
    .pipe(gulpif(args.watch,livereload()))
})
