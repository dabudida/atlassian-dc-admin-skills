import com.atlassian.jira.component.ComponentAccessor
import com.atlassian.plugin.ModuleDescriptor
import com.atlassian.plugin.Plugin
import com.atlassian.plugin.PluginAccessor

import java.lang.annotation.Annotation
import java.lang.reflect.Method
import java.util.jar.JarEntry
import java.util.jar.JarFile

/**
 * One-off Script Console script. Read-only: it calls no endpoint and changes nothing.
 * Lists the JAX-RS resources of the ScriptRunner and Automation plugins whose path or method mentions
 * export, import, report or behaviour, by reading @Path annotations from the plugin jars.
 * Use it to find the export URLs for JiraConfigSnapshotEndpoint after a plugin upgrade.
 * Classes are loaded without initialisation; classes of optional integrations that fail on reflection are skipped.
 */

final String PLUGIN_FILTER = '(?i).*(groovyrunner|codebarrel).*'
final String MATCH_FILTER = '(?i).*(export|import|report|behaviou?r).*'
final List<String> HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE']

PluginAccessor pluginAccessor = ComponentAccessor.pluginAccessor
List<String> lines = []

pluginAccessor.enabledPlugins.findAll { Plugin plugin -> plugin.key ==~ PLUGIN_FILTER }.each { Plugin plugin ->
  lines << "== ${plugin.key} ${plugin.pluginInformation?.version}".toString()

  // REST module base paths: /rest/<path>/<version>
  plugin.moduleDescriptors.findAll { ModuleDescriptor descriptor -> descriptor.class.name.contains('Rest') }.each { ModuleDescriptor descriptor ->
    String path = descriptorValue(descriptor, ['basePath', 'path'])
    if (path != null) {
      lines << "  rest-module ${descriptor.key}: path=${path} version=${descriptorValue(descriptor, ['version'])}".toString()
    }
  }

  File artifact = null
  try {
    artifact = plugin.pluginArtifact?.toFile()
  } catch (Exception artifactError) {
    lines << "  no artifact: ${artifactError.message}".toString()
  }
  if (artifact == null || !artifact.isFile()) {
    return
  }

  JarFile jar = new JarFile(artifact)
  int skipped = 0
  try {
    jar.entries().toList()
      .findAll { JarEntry entry -> entry.name.endsWith('.class') && !entry.name.contains('$') }
      .each { JarEntry entry ->
        String className = entry.name.replace('/', '.').replaceAll(/\.class$/, '')
        try {
          Class<?> resource = Class.forName(className, false, plugin.classLoader)
          String classPath = annotationValue(resource.annotations, 'Path')
          if (classPath == null) {
            return
          }
          List<String> methodLines = resource.declaredMethods.collect { Method method ->
            String httpMethod = method.annotations.collect { Annotation annotation -> annotation.annotationType().simpleName }.find { String name -> name in HTTP_METHODS }
            if (httpMethod == null) {
              return null
            }
            String methodPath = annotationValue(method.annotations, 'Path') ?: ''
            if (!("${className} ${classPath}/${methodPath} ${method.name}" ==~ MATCH_FILTER)) {
              return null
            }
            String produces = annotationValue(method.annotations, 'Produces') ?: ''
            return "    ${httpMethod} ${classPath}/${methodPath} ${method.name}() ${produces}".toString()
          }.findAll { String line -> line }
          if (methodLines) {
            lines << "  class ${className} @Path(${classPath})".toString()
            lines.addAll(methodLines)
          }
        } catch (Throwable reflectionError) {
          skipped++
        }
      }
  } finally {
    jar.close()
  }
  lines << "  skipped unreadable classes: ${skipped}".toString()
}

return lines.join('\n')

// Methods

/** value() of an annotation by its simple name; arrays are joined, annotations without value() give ''. */
String annotationValue(Annotation[] annotations, String simpleName) {
  Annotation found = annotations.find { Annotation annotation -> annotation.annotationType().simpleName == simpleName }
  if (found == null) {
    return null
  }
  if (!found.annotationType().declaredMethods.any { Method method -> method.name == 'value' }) {
    return ''
  }
  Object value = found.annotationType().getMethod('value').invoke(found)
  return value instanceof Object[] ? (value as Object[]).join(',') : String.valueOf(value)
}

/** First readable property of a module descriptor. */
String descriptorValue(ModuleDescriptor descriptor, List<String> names) {
  for (String name : names) {
    try {
      Object value = descriptor."${name}"
      if (value != null) {
        return String.valueOf(value)
      }
    } catch (MissingPropertyException absent) {
      // Not every descriptor type has this property; try the next name
      continue
    }
  }
  return null
}
